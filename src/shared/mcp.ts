import { z } from "zod"

export type McpMessageType = 'error' | 'warning'

export type McpServer = {
	name: string
	config: string
	status: "connected" | "connecting" | "disconnected"
	error?: string
	messageType?: McpMessageType
	tools?: McpTool[]
	resources?: McpResource[]
	resourceTemplates?: McpResourceTemplate[]
}

// Updated to match Zod schema output
export type McpToolInputSchema = {
	type: "object"
	properties?: Record<string, unknown>
	required?: string[]
}

export type McpTool = {
	name: string
	description?: string
	inputSchema?: McpToolInputSchema
}

export type McpResource = {
	uri: string
	name?: string
	description?: string
	mimeType?: string
}

export type McpResourceTemplate = {
	uriTemplate: string
	name?: string
	description?: string
	mimeType?: string
}

export type McpToolCallContent = {
	type: string
	text: string
}

export type McpToolCallResponse = {
	content: McpToolCallContent[]
	isError?: boolean
}

export type McpResourceContent = {
	uri: string
	mimeType?: string
	text: string
}

export type McpResourceResponse = {
	contents: McpResourceContent[]
}
