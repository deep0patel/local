import * as vscode from "vscode";
import {
  createServer as createHttpServer,
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from "http";
import * as net from "net";
import { Server as SocketIOServer, Socket } from "socket.io";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import {
  Implementation,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import * as StatusBarIcon from "./ui/statusbaricon";
import { URL } from "url";
import * as fs from "fs";
import * as path from "path";

const FIGMA_SOCKET_IO_PORT = 32896;
const MCP_HTTP_PORT = 3001;
const MCP_SSE_PATH = "/zapcode-mcp-sse";
const MCP_MESSAGE_PATH = "/mcp-messages";

// --- Global Variables ---
// Figma Connection
let figmaHttpServer: HttpServer | null = null;
let io: SocketIOServer | null = null;
let connectedFigmaClient: Socket | null = null;
let figmaContextRequests = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason?: any) => void }
>();
const figmaHttpConnections = new Set<net.Socket>(); // Set to track HTTP connections

// MCP Connection (for Cline)
let mcpHttpServer: HttpServer | null = null;
let mcpServerInstance: McpServer | null = null;
let mcpSseTransports = new Map<string, SSEServerTransport>();

// General
let outputChannel: vscode.OutputChannel;
let isServerActive = false;

// --- Interfaces ---
interface FigmaContext {
  prompt: string;
  HTML: string;
  CSS: string;
  image: string;
  tech_config: Record<string, any>;
  assets: Array<{ name: string; data: string; type: string }>;
}
interface ContextRequestPayload {
  requestId: string;
}
interface ContextResponsePayload {
  requestId: string;
  payload?: FigmaContext;
  error?: string;
}

// --- Socket.IO Server Logic (for Figma - mostly unchanged) ---
function startSocketIOServer(context: vscode.ExtensionContext): Promise<void> {
  return new Promise((resolve, reject) => {
    outputChannel.appendLine(
      `Attempting to start Socket.IO server for Figma on port ${FIGMA_SOCKET_IO_PORT}...`
    );
    if (figmaHttpServer || io) {
      outputChannel.appendLine(
        "Figma Socket.IO server seems to be already running."
      );
      resolve();
      return;
    }
    try {
      figmaHttpServer = createHttpServer();
      io = new SocketIOServer(figmaHttpServer, {
        maxHttpBufferSize: 1e8,
        cors: { origin: "*" },
      });

      io.on("connection", (socket) => {
        outputChannel.appendLine(
          `Figma Socket.IO client connected: ${socket.id}`
        );
        if (connectedFigmaClient) {
          connectedFigmaClient.disconnect(true);
        }
        connectedFigmaClient = socket;
        updateFigmaConnectionStatusInStatusBar(true);

        socket.on("context_response", (data: ContextResponsePayload) => {
          // ...(handler remains the same)
          outputChannel.appendLine(
            `Received 'context_response' for requestId: ${data?.requestId}`
          );
          if (!data?.requestId) return;
          const request = figmaContextRequests.get(data.requestId);
          if (request) {
            if (data.error) request.reject(new Error(data.error));
            else if (data.payload) request.resolve(data.payload);
            else request.reject(new Error("Invalid context_response"));
            figmaContextRequests.delete(data.requestId);
          }
        });

        if (figmaHttpServer) {
          figmaHttpServer.on("connection", (socket: net.Socket) => {
            // outputChannel.appendLine(`New HTTP connection established for Socket.IO Server`); // Optional log
            figmaHttpConnections.add(socket);
            socket.on("close", () => {
              // outputChannel.appendLine(`HTTP connection closed for Socket.IO Server`); // Optional log
              figmaHttpConnections.delete(socket);
            });
          });
        }

        socket.on("disconnect", (reason) => {
          outputChannel.appendLine(
            `Figma Socket.IO client disconnected: ${socket.id}. Reason: ${reason}`
          );
          if (connectedFigmaClient === socket) {
            connectedFigmaClient = null;
            figmaContextRequests.forEach((req, id) => {
              req.reject(
                new Error(`Figma plugin disconnected (Reason: ${reason})`)
              );
              figmaContextRequests.delete(id);
            });
            updateFigmaConnectionStatusInStatusBar(false);
          }
        });
        socket.on("error", (err) =>
          outputChannel.appendLine(
            `Figma Socket.IO error for ${socket.id}: ${err.message}`
          )
        );
        socket.emit("pong", "pong");
      });

      figmaHttpServer.on("error", (error: NodeJS.ErrnoException) => {
        outputChannel.appendLine(`Figma HTTP Server error: ${error.message}`);
        vscode.window.showErrorMessage(
          `Failed to start Figma Server on port ${FIGMA_SOCKET_IO_PORT}. Code: ${error.code}`
        );
        StatusBarIcon.showActivate();
        isServerActive = false;
        if (io) {
          io.close();
          io = null;
        }
        figmaHttpServer = null;
        figmaHttpConnections.clear();
        reject(error);
      });

      figmaHttpServer.listen(FIGMA_SOCKET_IO_PORT, () => {
        outputChannel.appendLine(
          `Figma Socket.IO server listening on port ${FIGMA_SOCKET_IO_PORT}`
        );
        updateFigmaConnectionStatusInStatusBar(false);
        resolve();
      });
    } catch (error) {
      outputChannel.appendLine(
        `Error creating Figma Socket.IO server: ${error}`
      );
      reject(error);
    }
  });
}

function stopSocketIOServer(): Promise<void> {
  return new Promise((resolve) => {
    outputChannel.appendLine("Stopping Figma Socket.IO server...");
    figmaContextRequests.forEach((req) =>
      req.reject("Extension shutting down")
    );
    figmaContextRequests.clear();
    if (connectedFigmaClient) connectedFigmaClient.disconnect(true);
    connectedFigmaClient = null;

    let ioClosed = false,
      httpClosed = false;
    const checkDone = () => {
      if (ioClosed && httpClosed) {
        outputChannel.appendLine("Socket.IO and HTTP servers stopped.");
        resolve();
      }
    };

    if (io) {
      io.close((err?: Error) => {
        if (err)
          outputChannel.appendLine(
            `Error closing Socket.IO instance: ${err.message}`
          );
        else outputChannel.appendLine("Socket.IO instance closed.");
        io = null;
        ioClosed = true;
        checkDone();
      });
    } else {
      outputChannel.appendLine("Socket.IO instance was not running.");
      ioClosed = true;
      checkDone();
    }
    outputChannel.appendLine(
      `Destroying ${figmaHttpConnections.size} existing HTTP connections...`
    );
    figmaHttpConnections.forEach((socket) => {
      socket.destroy(); // Force close the underlying TCP connection
    });
    figmaHttpConnections.clear(); // Clear the tracking set

    // 3. Now close the HTTP server (should fire callback much faster)
    if (figmaHttpServer) {
      figmaHttpServer.close((err?: Error) => {
        if (err)
          outputChannel.appendLine(`Error closing HTTP server: ${err.message}`);
        else outputChannel.appendLine("HTTP server closed.");
        figmaHttpServer = null;
        httpClosed = true;
        checkDone();
      });
    } else {
      outputChannel.appendLine("HTTP server was not running.");
      httpClosed = true;
      checkDone();
    }
  });
}

// --- MCP Server Logic (HTTP/SSE for Cline) ---
async function startMcpServer(context: vscode.ExtensionContext): Promise<void> {
  outputChannel.appendLine(
    `Attempting to start MCP HTTP/SSE server on port ${MCP_HTTP_PORT}...`
  );
  if (mcpHttpServer || mcpServerInstance) {
    outputChannel.appendLine(
      "MCP HTTP/SSE server seems to be already running."
    );
    return;
  }

  const serverInfo: Implementation = {
    name: "figma-context-mcp-server",
    version: context.extension.packageJSON.version ?? "0.0.1",
  };
  const serverOptions = {
    capabilities: {
      tools: { listChanged: false },
    },
  };

  try {
    mcpServerInstance = new McpServer(serverInfo, serverOptions);

    // --- Define MCP Tool  ---
    // mcpServerInstance.tool(
    //   "get_figma_context",
    //   "Retrieves the selected Figma frame context (HTML, CSS, prompt, image, assets) via Figma Plugin.",
    //   {},
    //   async () => {
    //     // Tool handler
    //     outputChannel.appendLine("Figma context called.");
    //     if (!connectedFigmaClient || !connectedFigmaClient.connected) {
    //       outputChannel.appendLine(
    //         "Error: Figma plugin not connected via Socket.IO for MCP tool call."
    //       );
    //       return {
    //         isError: true,
    //         content: [
    //           { type: "text", text: "Error: Figma plugin is not connected." },
    //         ],
    //       };
    //     }
    //     const requestId = `figma-ctx-${Date.now()}-${Math.random()
    //       .toString(36)
    //       .substring(7)}`;
    //     try {
    //       outputChannel.appendLine(
    //         `Emitting 'request_context' (requestId: ${requestId}) to Figma`
    //       );
    //       connectedFigmaClient.emit("request_context", { requestId });
    //       const context = await new Promise<FigmaContext>((resolve, reject) => {
    //         figmaContextRequests.set(requestId, { resolve, reject });
    //         setTimeout(() => {
    //           if (figmaContextRequests.has(requestId)) {
    //             reject(
    //               new Error("Request to Figma plugin timed out (30 seconds).")
    //             );
    //             figmaContextRequests.delete(requestId);
    //           }
    //         }, 30000);
    //       });
    //       outputChannel.appendLine(
    //         `Successfully received context for request ${requestId}.`
    //       );

    //       return { content: [{ type: "text", text: JSON.stringify(context) }] };
    //     } catch (error: any) {
    //       outputChannel.appendLine(
    //         `Error requesting/receiving Figma context via Socket.IO: ${error.message}`
    //       );
    //       return {
    //         isError: true,
    //         content: [
    //           {
    //             type: "text",
    //             text: `Error getting Figma context: ${error.message}`,
    //           },
    //         ],
    //       };
    //     }
    //   }
    // );

    mcpServerInstance.tool(
      "get_figma_context",
      "Retrieves the selected Figma frame context (HTML, CSS, prompt, image, assets) via Figma Plugin.",
      {}, // No input schema needed for this specific tool
      async () => {
        // Tool handler
        outputChannel.appendLine("Figma context called.");
        if (!connectedFigmaClient || !connectedFigmaClient.connected) {
          outputChannel.appendLine(
            "Error: Figma plugin not connected via Socket.IO for MCP tool call."
          );
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: Figma plugin is not connected." },
            ],
          };
        }

        const requestId = `figma-ctx-${Date.now()}-${Math.random()
          .toString(36)
          .substring(7)}`;
        try {
          outputChannel.appendLine(
            `Emitting 'request_context' (requestId: ${requestId}) to Figma`
          );
          connectedFigmaClient.emit("request_context", { requestId });

          const context = await new Promise<FigmaContext>((resolve, reject) => {
            figmaContextRequests.set(requestId, { resolve, reject });
            setTimeout(() => {
              if (figmaContextRequests.has(requestId)) {
                reject(
                  new Error("Request to Figma plugin timed out (30 seconds).")
                );
                figmaContextRequests.delete(requestId);
              }
            }, 30000);
          });

          outputChannel.appendLine(
            `Successfully received context for request ${requestId}.`
          );

          // Handle SVG assets if present
          let assetResults: { savedFiles: string[]; errors: string[] } = {
            savedFiles: [],
            errors: [],
          };
          if (context.assets && context.assets.length > 0) {
            const workspacePath =
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspacePath) {
              assetResults = await saveSvgAssets(context.assets, workspacePath);
              outputChannel.appendLine(
                `Saved ${assetResults.savedFiles.length} SVG assets to workspace`
              );
              if (assetResults.errors.length > 0) {
                outputChannel.appendLine(
                  `SVG save errors: ${assetResults.errors.join(", ")}`
                );
              }
            } else {
              outputChannel.appendLine(
                "No workspace folder found for saving assets"
              );
            }
          }

          // Build MCP Content Array
          const mcpContent: Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
          > = [];

          // Add the Image Content (if available)
          if (context.image) {
            mcpContent.push({
              type: "image",
              data: context.image,
              mimeType: "image/png",
            });
          }

          // Add the Text Content with saved asset information
          const textDetails = `
Figma Context Details:

Prompt Suggestion:
${context.prompt}

Technology Configuration:
\`\`\`json
${JSON.stringify(context.tech_config, null, 2)}
\`\`\`

SVG Assets ${
            assetResults.savedFiles.length > 0
              ? "(Saved to workspace):"
              : "(None saved)"
          }
${assetResults.savedFiles.map((path) => `- ${path}`).join("\n")}
${
  assetResults.errors.length > 0
    ? "\nSVG Save Errors:\n" +
      assetResults.errors.map((err) => `- ${err}`).join("\n")
    : ""
}

HTML Structure:
\`\`\`html
${context.HTML}
\`\`\`

CSS Styles:
\`\`\`css
${context.CSS}
\`\`\``;

          mcpContent.push({
            type: "text",
            text: textDetails,
          });

          return { content: mcpContent };
        } catch (error: any) {
          outputChannel.appendLine(
            `Error requesting/receiving Figma context via Socket.IO: ${error.message}`
          );
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error getting Figma context: ${error.message}`,
              },
            ],
          };
        }
      }
    );
  } catch (error: any) {
    outputChannel.appendLine(
      `Failed to create MCP Server instance: ${error.message}`
    );
    throw error;
  }

  // 2. Create and Start the HTTP Server for MCP
  return new Promise((resolve, reject) => {
    mcpHttpServer = createHttpServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const requestUrl = new URL(req.url || "", `http://${req.headers.host}`);
        outputChannel.appendLine(
          `MCP HTTP Server received request: ${req.method} ${requestUrl.pathname}`
        );

        if (req.method === "GET" && requestUrl.pathname === MCP_SSE_PATH) {
          outputChannel.appendLine(
            `New SSE connection request from ${req.socket.remoteAddress}`
          );
          try {
            // Create a *new* transport for this specific client connection
            const transport = new SSEServerTransport(MCP_MESSAGE_PATH, res); // Pass the response object
            mcpSseTransports.set(transport.sessionId, transport);
            outputChannel.appendLine(
              `Created SSEServerTransport with sessionId: ${transport.sessionId}`
            );

            // Handle client disconnection for *this* transport
            req.socket.on("close", () => {
              outputChannel.appendLine(
                `SSE connection closed for sessionId: ${transport.sessionId}`
              );
              mcpSseTransports.delete(transport.sessionId);
              interface TransportCloseError {
                message: string;
              }

              transport
                .close()
                .catch((e: TransportCloseError) =>
                  outputChannel.appendLine(
                    `Error closing transport on socket close: ${e.message}`
                  )
                );
            });

            // Connect the *single* mcpServerInstance logic to *this* client's transport
            // The SDK handles routing messages for this session internally
            await mcpServerInstance!.connect(transport); // Use the existing MCP server logic instance
            outputChannel.appendLine(
              `MCP Server logic connected to transport for sessionId: ${transport.sessionId}`
            );
          } catch (error: any) {
            outputChannel.appendLine(
              `Error setting up SSE transport: ${error.message}`
            );
            if (!res.writableEnded) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal Server Error setting up SSE");
            }
          }
        } else if (
          req.method === "POST" &&
          requestUrl.pathname === MCP_MESSAGE_PATH
        ) {
          // --- Handle message POST from Cline ---
          const sessionId = requestUrl.searchParams.get("sessionId");
          if (!sessionId) {
            outputChannel.appendLine(
              `Received POST on ${MCP_MESSAGE_PATH} without sessionId`
            );
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request: Missing sessionId");
            return;
          }

          const transport = mcpSseTransports.get(sessionId);
          if (transport) {
            outputChannel.appendLine(
              `Handling POST message for sessionId: ${sessionId}`
            );
            try {
              await transport.handlePostMessage(req, res); // Let the transport handle the message body
            } catch (error: any) {
              outputChannel.appendLine(
                `Error in handlePostMessage for sessionId ${sessionId}: ${error.message}`
              );
              if (!res.writableEnded) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal Server Error handling message");
              }
            }
          } else {
            outputChannel.appendLine(
              `Received POST for unknown sessionId: ${sessionId}`
            );
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found: Invalid or expired session");
          }
        } else {
          // Handle other HTTP requests (e.g., health check, or 404)
          outputChannel.appendLine(
            `Unhandled MCP HTTP request: ${req.method} ${requestUrl.pathname}`
          );
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      }
    );

    mcpHttpServer.on("error", (error: NodeJS.ErrnoException) => {
      outputChannel.appendLine(`MCP HTTP Server error: ${error.message}`);
      vscode.window.showErrorMessage(
        `Failed to start MCP Server on port ${MCP_HTTP_PORT}. Code: ${error.code}`
      );
      StatusBarIcon.showActivate();
      isServerActive = false;
      mcpHttpServer = null;
      mcpServerInstance = null; // Ensure MCP instance is cleared if HTTP fails
      reject(error);
    });

    mcpHttpServer.listen(MCP_HTTP_PORT, () => {
      outputChannel.appendLine(
        `MCP HTTP/SSE server listening on http://localhost:${MCP_HTTP_PORT}${MCP_SSE_PATH}`
      );
      // Note: Connection status (green dot) depends on Cline connecting, not just listening.
      resolve();
    });
  });
}

async function stopMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    outputChannel.appendLine("Stopping MCP HTTP/SSE server...");
    // 1. Close all active SSE transports
    const closePromises: Promise<void>[] = [];
    mcpSseTransports.forEach((transport) => {
      outputChannel.appendLine(
        `Closing transport for sessionId: ${transport.sessionId}`
      );
      interface TransportCloseError {
        message: string;
      }

      closePromises.push(
        transport
          .close()
          .catch((e: TransportCloseError) =>
            outputChannel.appendLine(
              `Error closing transport ${transport.sessionId}: ${e.message}`
            )
          )
      );
    });
    mcpSseTransports.clear();

    // 2. Close the HTTP server after trying to close transports
    Promise.allSettled(closePromises).then(() => {
      if (mcpHttpServer) {
        mcpHttpServer.close((err?: Error) => {
          if (err)
            outputChannel.appendLine(
              `Error closing MCP HTTP server: ${err.message}`
            );
          else outputChannel.appendLine("MCP HTTP server closed.");
          mcpHttpServer = null;
          mcpServerInstance = null; // Clear MCP logic instance
          resolve();
        });
      } else {
        outputChannel.appendLine("MCP HTTP server was not running.");
        mcpServerInstance = null;
        resolve();
      }
    });
  });
}

// --- Status Bar Update Helper (Needs Adaptation) ---
function updateFigmaConnectionStatusInStatusBar(isConnected: boolean) {
  if (!isServerActive) return;
  outputChannel.appendLine(
    `Figma Connection Status (Socket.IO): ${
      isConnected ? "Connected" : "Disconnected"
    }`
  );
}

// --- Utility Functions ---
function isValidBase64(str: string): boolean {
  try {
    return Buffer.from(str, "base64").toString("base64") === str;
  } catch {
    return false;
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- Save SVG Assets Function ---
async function saveSvgAssets(
  assets: Array<{ name: string; data: string; type: string }>,
  workspacePath: string
): Promise<{ savedFiles: string[]; errors: string[] }> {
  const savedFiles: string[] = [];
  const errors: string[] = [];

  if (!Array.isArray(assets)) {
    outputChannel.appendLine("Warning: No assets array provided");
    return { savedFiles, errors: ["No assets provided"] };
  }

  const assetsDir = path.join(workspacePath, "assets", "svg");

  try {
    // Create assets directory if it doesn't exist
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    for (const asset of assets) {
      if (!asset || typeof asset !== "object") {
        errors.push(`Invalid asset object`);
        continue;
      }

      if (asset.type !== "svg") {
        errors.push(`Asset ${asset.name} is not an SVG`);
        continue;
      }

      if (!asset.name) {
        errors.push("Asset name is required");
        continue;
      }

      if (!asset.data) {
        errors.push(`No data provided for asset ${asset.name}`);
        continue;
      }

      try {
        const fileName = sanitizeFileName(asset.name) + ".svg";
        const filePath = path.join(assetsDir, fileName);

        // Handle both base64 and raw SVG data
        let svgContent: string;
        if (asset.data.startsWith("data:image/svg+xml;base64,")) {
          const base64Data = asset.data.split(",")[1];
          if (!isValidBase64(base64Data)) {
            errors.push(`Invalid base64 data for ${asset.name}`);
            continue;
          }
          svgContent = Buffer.from(base64Data, "base64").toString();
        } else if (asset.data.trim().startsWith("<svg")) {
          svgContent = asset.data;
        } else {
          errors.push(`Invalid SVG data format for ${asset.name}`);
          continue;
        }

        // Basic SVG validation
        if (!svgContent.includes("<svg") || !svgContent.includes("</svg>")) {
          errors.push(`Invalid SVG content for ${asset.name}`);
          continue;
        }

        fs.writeFileSync(filePath, svgContent);
        savedFiles.push(filePath);
        outputChannel.appendLine(`Successfully saved SVG: ${filePath}`);
      } catch (err: any) {
        errors.push(`Error saving ${asset.name}: ${err.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`General error: ${err.message}`);
  }

  return { savedFiles, errors };
}

// --- Extension Activation / Deactivation ---
export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Zapcode Extension");
  outputChannel.appendLine("Zapcode extension loading...");

  const { globalState } = context;
  StatusBarIcon.initialize();
  StatusBarIcon.showActivate();

  // --- Activate Command ---
  context.subscriptions.push(
    vscode.commands.registerCommand("figma-to-vscode.activate", async () => {
      if (isServerActive) {
        vscode.window.showInformationMessage("ZapCode is already active.");
        return;
      }
      StatusBarIcon.showLoading();
      try {
        await startSocketIOServer(context);
        await startMcpServer(context);

        isServerActive = true;
        await globalState.update("zapcodeWorkspace", vscode.workspace.name);
        vscode.window.showInformationMessage(
          `ZapCode activated! Figma SIO on ${FIGMA_SOCKET_IO_PORT}, MCP SSE on ${MCP_HTTP_PORT}.`
        );
        StatusBarIcon.showShutdown();
      } catch (error) {
        outputChannel.appendLine(`Activation failed: ${error}`);
        StatusBarIcon.showActivate();
        isServerActive = false;
        // Attempt cleanup in case one started but the other failed
        await stopSocketIOServer();
        await stopMcpServer();
      }
    })
  );

  // --- ShutDown Command ---
  context.subscriptions.push(
    vscode.commands.registerCommand("figma-to-vscode.shutDown", async () => {
      if (!isServerActive) {
        vscode.window.showInformationMessage("ZapCode is already stopped.");
        return;
      }
      outputChannel.appendLine("Command 'figma-to-vscode.shutDown' triggered.");
      StatusBarIcon.showLoading();
      try {
        // Stop BOTH servers
        await stopSocketIOServer();
        outputChannel.appendLine("Stopped Figma");
        await stopMcpServer();
        outputChannel.appendLine("Stopped MCP");

        await globalState.update("zapcodeWorkspace", undefined);
        vscode.window.showInformationMessage("ZapCode stopped.");
      } catch (error) {
        outputChannel.appendLine(`Error during shutdown: ${error}`);
        vscode.window.showErrorMessage("Error stopping ZapCode.");
      } finally {
        isServerActive = false;
        StatusBarIcon.showActivate();
      }
    })
  );

  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Zapcode extension activation sequence complete.");
}

// --- Deactivate Function ---
export async function deactivate() {
  outputChannel.appendLine("Deactivating Zapcode extension...");
  if (isServerActive) {
    await stopSocketIOServer();
    await stopMcpServer();
    isServerActive = false;
  }
  outputChannel.appendLine("Deactivation complete.");
}
