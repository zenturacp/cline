import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import chokidar, { FSWatcher } from "chokidar"
import delay from "delay"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { z } from "zod"
import { ClineProvider, GlobalFileNames } from "../../core/webview/ClineProvider"
import {
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
	McpMessageType,
	McpToolCallContent,
	McpResourceContent,
} from "../../shared/mcp"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"

export type McpConnection = {
	server: McpServer
	client: Client
	transport: StdioClientTransport
}

// StdioServerParameters
const StdioConfigSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional(),
})

const McpSettingsSchema = z.object({
	mcpServers: z.record(StdioConfigSchema),
})

type ValidationResult = {
	message: string
	messageType: McpMessageType
} | null

export class McpHub {
	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
	private settingsWatcher?: vscode.FileSystemWatcher
	private fileWatchers: Map<string, FSWatcher> = new Map()
	connections: McpConnection[] = []
	isConnecting: boolean = false

	constructor(provider: ClineProvider) {
		this.providerRef = new WeakRef(provider)
		this.watchMcpSettingsFile()
		this.initializeMcpServers()
	}

	private resolveVSCodeVariables(value: string): string {
		if (!value.includes("${")) return value

		const workspaceFolders = vscode.workspace.workspaceFolders

		if (!workspaceFolders || workspaceFolders.length === 0) {
			return value
		}

		value = value.replace(/\${workspaceFolder\}/g, workspaceFolders[0].uri.fsPath)

		value = value.replace(/\${workspaceFolder:([^}]+)}/g, (match, name) => {
			const folder = workspaceFolders.find(f => f.name === name)
			if (!folder) {
				return match
			}
			return folder.uri.fsPath
		})

		value = value.replace(/\${workspaceFolder\.(\d+)}/g, (match, index) => {
			const idx = parseInt(index, 10)
			if (idx >= 0 && idx < workspaceFolders.length) {
				return workspaceFolders[idx].uri.fsPath
			}
			return match
		})

		return value
	}

	private resolveConfigVariables(config: StdioServerParameters): StdioServerParameters {
		const resolvedConfig = { ...config }
		
		resolvedConfig.command = this.resolveVSCodeVariables(config.command)
		
		if (config.args) {
			resolvedConfig.args = config.args.map(arg => this.resolveVSCodeVariables(arg))
		}
		
		if (config.env) {
			resolvedConfig.env = Object.fromEntries(
				Object.entries(config.env).map(([key, value]) => [
					key,
					typeof value === 'string' ? this.resolveVSCodeVariables(value) : value
				])
			)
		}
		
		return resolvedConfig
	}

	private validateResolvedConfig(name: string, config: StdioServerParameters): ValidationResult {
		const workspaceFolders = vscode.workspace.workspaceFolders

		const configStr = JSON.stringify(config)
		if (configStr.includes("${workspaceFolder")) {
			if (!workspaceFolders || workspaceFolders.length === 0) {
				return {
					message: "No workspace folder is open. Please open a workspace folder to use workspace-relative paths.",
					messageType: "warning"
				}
			}
			
			const unresolved = configStr.match(/\${workspaceFolder:([^}]+)}/g)
			if (unresolved) {
				const missingFolders = unresolved.map(match => {
					const name = match.match(/\${workspaceFolder:([^}]+)}/)?.[1]
					return name
				}).filter(Boolean)
				return {
					message: `Could not resolve workspace folder(s): ${missingFolders.join(", ")}`,
					messageType: "error"
				}
			}

			const unresolvedIndexed = configStr.match(/\${workspaceFolder\.(\d+)}/g)
			if (unresolvedIndexed) {
				const indices = unresolvedIndexed.map(match => {
					const idx = match.match(/\${workspaceFolder\.(\d+)}/)?.[1]
					return parseInt(idx!, 10)
				})
				const maxIndex = Math.max(...indices)
				if (maxIndex >= workspaceFolders.length) {
					return {
						message: `Workspace folder index ${maxIndex} is out of bounds. Only ${workspaceFolders.length} folder(s) are open.`,
						messageType: "error"
					}
				}
			}
		}

		return null
	}

	getServers(): McpServer[] {
		return this.connections.map((conn) => conn.server)
	}

	async getMcpServersPath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpServersPath = await provider.ensureMcpServersDirectoryExists()
		return mcpServersPath
	}

	async getMcpSettingsFilePath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpSettingsFilePath = path.join(
			await provider.ensureSettingsDirectoryExists(),
			GlobalFileNames.mcpSettings,
		)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {
    
  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	private async watchMcpSettingsFile(): Promise<void> {
		const settingsPath = await this.getMcpSettingsFilePath()
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(async (document) => {
				if (arePathsEqual(document.uri.fsPath, settingsPath)) {
					const content = await fs.readFile(settingsPath, "utf-8")
					const errorMessage =
						"Invalid MCP settings format. Please ensure your settings follow the correct JSON format."
					let config: any
					try {
						config = JSON.parse(content)
					} catch (error) {
						vscode.window.showErrorMessage(errorMessage)
						return
					}
					const result = McpSettingsSchema.safeParse(config)
					if (!result.success) {
						vscode.window.showErrorMessage(errorMessage)
						return
					}
					try {
						vscode.window.showInformationMessage("Updating MCP servers...")
						await this.updateServerConnections(result.data.mcpServers || {})
						vscode.window.showInformationMessage("MCP servers updated")
					} catch (error) {
						console.error("Failed to process MCP settings change:", error)
					}
				}
			}),
		)
	}

	private async initializeMcpServers(): Promise<void> {
		try {
			const settingsPath = await this.getMcpSettingsFilePath()
			const content = await fs.readFile(settingsPath, "utf-8")
			const config = JSON.parse(content)
			await this.updateServerConnections(config.mcpServers || {})
		} catch (error) {
			console.error("Failed to initialize MCP servers:", error)
		}
	}

	private async connectToServer(name: string, config: StdioServerParameters): Promise<void> {
		const resolvedConfig = this.resolveConfigVariables(config)
		
		const validationResult = this.validateResolvedConfig(name, resolvedConfig)
		if (validationResult) {
			const connection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "disconnected",
					error: validationResult.message,
					messageType: validationResult.messageType
				},
				client: new Client(
					{ name: "Cline", version: "1.0.0" },
					{ capabilities: {} }
				),
				transport: new StdioClientTransport({
					command: "echo",
					args: ["Placeholder transport - server disabled due to configuration error"],
				}),
			}
			this.connections = this.connections.filter((conn) => conn.server.name !== name)
			this.connections.push(connection)
			return
		}
		
		this.connections = this.connections.filter((conn) => conn.server.name !== name)

		try {
			const client = new Client(
				{
					name: "Cline",
					version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {},
				},
			)

			const transport = new StdioClientTransport({
				command: resolvedConfig.command,
				args: resolvedConfig.args,
				env: {
					...resolvedConfig.env,
					...(process.env.PATH ? { PATH: process.env.PATH } : {}),
				},
				stderr: "pipe",
			})

			transport.onerror = async (error) => {
				console.error(`Transport error for "${name}":`, error)
				const connection = this.connections.find((conn) => conn.server.name === name)
				if (connection) {
					connection.server.status = "disconnected"
					connection.server.error = error.message
					connection.server.messageType = "error"
				}
				await this.notifyWebviewOfServerChanges()
			}

			transport.onclose = async () => {
				const connection = this.connections.find((conn) => conn.server.name === name)
				if (connection) {
					connection.server.status = "disconnected"
				}
				await this.notifyWebviewOfServerChanges()
			}

			if (!StdioConfigSchema.safeParse(resolvedConfig).success) {
				console.error(`Invalid config for "${name}": missing or invalid parameters`)
				const connection: McpConnection = {
					server: {
						name,
						config: JSON.stringify(config),
						status: "disconnected",
						error: "Invalid config: missing or invalid parameters",
						messageType: "error"
					},
					client,
					transport,
				}
				this.connections.push(connection)
				return
			}

			const connection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "connecting",
				},
				client,
				transport,
			}
			this.connections.push(connection)

			await transport.start()
			const stderrStream = transport.stderr
			if (stderrStream) {
				stderrStream.on("data", async (data: Buffer) => {
					const errorOutput = data.toString()
					console.error(`Server "${name}" stderr:`, errorOutput)
					const connection = this.connections.find((conn) => conn.server.name === name)
					if (connection) {
						connection.server.error = errorOutput
						connection.server.messageType = "error"
						if (connection.server.status === "disconnected") {
							await this.notifyWebviewOfServerChanges()
						}
					}
				})
			} else {
				console.error(`No stderr stream for ${name}`)
			}
			transport.start = async () => {}

			await client.connect(transport)
			connection.server.status = "connected"
			connection.server.error = undefined
			connection.server.messageType = undefined

			const toolsResponse = await this.fetchToolsList(name)
			connection.server.tools = toolsResponse.map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema as any
			}))
			
			connection.server.resources = await this.fetchResourcesList(name)
			connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name)
		} catch (error) {
			const connection = this.connections.find((conn) => conn.server.name === name)
			if (connection) {
				connection.server.status = "disconnected"
				connection.server.error = error instanceof Error ? error.message : String(error)
				connection.server.messageType = "error"
			}
			throw error
		}
	}

	private appendErrorMessage(connection: McpConnection, error: string) {
		const newError = connection.server.error ? `${connection.server.error}\n${error}` : error
		connection.server.error = newError
		connection.server.messageType = "error"
	}

	private async fetchToolsList(serverName: string): Promise<McpTool[]> {
		try {
			const response = await this.connections
				.find((conn) => conn.server.name === serverName)
				?.client.request({ method: "tools/list" }, ListToolsResultSchema)
			return response?.tools || []
		} catch (error) {
			return []
		}
	}

	private async fetchResourcesList(serverName: string): Promise<McpResource[]> {
		try {
			const response = await this.connections
				.find((conn) => conn.server.name === serverName)
				?.client.request({ method: "resources/list" }, ListResourcesResultSchema)
			return response?.resources || []
		} catch (error) {
			return []
		}
	}

	private async fetchResourceTemplatesList(serverName: string): Promise<McpResourceTemplate[]> {
		try {
			const response = await this.connections
				.find((conn) => conn.server.name === serverName)
				?.client.request({ method: "resources/templates/list" }, ListResourceTemplatesResultSchema)
			return response?.resourceTemplates || []
		} catch (error) {
			return []
		}
	}

	async deleteConnection(name: string): Promise<void> {
		const connection = this.connections.find((conn) => conn.server.name === name)
		if (connection) {
			try {
				await connection.transport.close()
				await connection.client.close()
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
			this.connections = this.connections.filter((conn) => conn.server.name !== name)
		}
	}

	async updateServerConnections(newServers: Record<string, any>): Promise<void> {
		this.isConnecting = true
		this.removeAllFileWatchers()
		const currentNames = new Set(this.connections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name)
				console.log(`Deleted MCP server: ${name}`)
			}
		}

		for (const [name, config] of Object.entries(newServers)) {
			const currentConnection = this.connections.find((conn) => conn.server.name === name)
			const resolvedConfig = this.resolveConfigVariables(config)

			if (!currentConnection) {
				try {
					this.setupFileWatcher(name, resolvedConfig)
					await this.connectToServer(name, config)
				} catch (error) {
					console.error(`Failed to connect to new MCP server ${name}:`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				try {
					this.setupFileWatcher(name, resolvedConfig)
					await this.deleteConnection(name)
					await this.connectToServer(name, config)
					console.log(`Reconnected MCP server with updated config: ${name}`)
				} catch (error) {
					console.error(`Failed to reconnect MCP server ${name}:`, error)
				}
			}
		}
		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	private setupFileWatcher(name: string, config: any) {
		const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
		if (filePath) {
			const watcher = chokidar.watch(filePath, {})

			watcher.on("change", () => {
				console.log(`Detected change in ${filePath}. Restarting server ${name}...`)
				this.restartConnection(name)
			})

			this.fileWatchers.set(name, watcher)
		}
	}

	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watcher) => watcher.close())
		this.fileWatchers.clear()
	}

	async restartConnection(serverName: string): Promise<void> {
		this.isConnecting = true
		const provider = this.providerRef.deref()
		if (!provider) {
			return
		}

		const connection = this.connections.find((conn) => conn.server.name === serverName)
		const config = connection?.server.config
		if (config) {
			vscode.window.showInformationMessage(`Restarting ${serverName} MCP server...`)
			connection.server.status = "connecting"
			connection.server.error = undefined
			connection.server.messageType = undefined
			await this.notifyWebviewOfServerChanges()
			await delay(500)
			try {
				await this.deleteConnection(serverName)
				await this.connectToServer(serverName, JSON.parse(config))
				vscode.window.showInformationMessage(`${serverName} MCP server connected`)
			} catch (error) {
				console.error(`Failed to restart connection for ${serverName}:`, error)
				vscode.window.showErrorMessage(`Failed to connect to ${serverName} MCP server`)
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	private async notifyWebviewOfServerChanges(): Promise<void> {
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const serverOrder = Object.keys(config.mcpServers || {})
		await this.providerRef.deref()?.postMessageToWebview({
			type: "mcpServers",
			mcpServers: [...this.connections]
				.sort((a, b) => {
					const indexA = serverOrder.indexOf(a.server.name)
					const indexB = serverOrder.indexOf(b.server.name)
					return indexA - indexB
				})
				.map((connection) => connection.server),
		})
	}

	async readResource(serverName: string, uri: string): Promise<McpResourceResponse> {
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		if (!connection) {
			throw new Error(`No connection found for server: ${serverName}`)
		}
		const response = await connection.client.request(
			{
				method: "resources/read",
				params: {
					uri,
				},
			},
			ReadResourceResultSchema,
		)
		return {
			contents: response.contents.map(content => ({
				uri: content.uri,
				mimeType: content.mimeType,
				text: ('text' in content ? content.text : content.blob) as string
			}))
		}
	}

	async callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
	): Promise<McpToolCallResponse> {
		const connection = this.connections.find((conn) => conn.server.name === serverName)
		if (!connection) {
			throw new Error(
				`No connection found for server: ${serverName}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}
		const response = await connection.client.request(
			{
				method: "tools/call",
				params: {
					name: toolName,
					arguments: toolArguments,
				},
			},
			CallToolResultSchema,
		)
		return {
			content: response.content.map(content => ({
				type: content.type,
				text: ('text' in content ? content.text : content.data) as string
			})),
			isError: response.isError
		}
	}

	async dispose(): Promise<void> {
		this.removeAllFileWatchers()
		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}
		this.connections = []
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
		}
		this.disposables.forEach((d) => d.dispose())
	}
}
