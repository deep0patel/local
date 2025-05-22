import asyncio
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Callable

import socketio # For Figma connection
from aiohttp import web # For MCP HTTP/SSE server
from mcp import server as mcp_server # MCP SDK
from mcp import types as mcp_types # MCP SDK types

# --- Configuration ---
FIGMA_SOCKET_IO_PORT = 32896
MCP_HTTP_PORT = 3001
MCP_SSE_PATH = "/zapcode-mcp-sse"  # For SSE connections
MCP_MESSAGE_PATH = "/mcp-messages" # For client-to-server messages (POST)

# --- Logging ---
# In a real VS Code extension, you'd integrate with VS Code's OutputChannel.
# For a standalone Python script, basic logging is fine.
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Global State ---
# Figma Connection
sio_server: Optional[socketio.AsyncServer] = None
figma_app: Optional[web.Application] = None # To host the socket.io server
connected_figma_client_sid: Optional[str] = None
figma_context_requests: Dict[str, Tuple[asyncio.Future, asyncio.TimerHandle]] = {}

# MCP Connection
mcp_app: Optional[web.Application] = None # To host MCP HTTP/SSE
mcp_http_runner: Optional[web.AppRunner] = None
mcp_http_site: Optional[web.TCPSite] = None
mcp_server_instance: Optional[mcp_server.Server] = None
mcp_sse_clients: Dict[str, web.StreamResponse] = {} # session_id -> StreamResponse
mcp_client_message_queues: Dict[str, asyncio.Queue] = {} # session_id -> Queue for incoming messages

is_server_active = False

# --- Interfaces (Data Classes or TypedDicts) ---
class FigmaAsset(mcp_types.BaseModel): # Using Pydantic for validation if you want
    name: str
    data: str # Can be raw SVG string or base64
    type: str # e.g., "svg"

class FigmaContext(mcp_types.BaseModel):
    prompt: str
    HTML: str
    CSS: str
    image: str # Assuming base64 encoded PNG data
    tech_config: Dict[str, Any]
    assets: List[FigmaAsset]

class ContextRequestPayload(mcp_types.BaseModel):
    requestId: str

class ContextResponsePayload(mcp_types.BaseModel):
    requestId: str
    payload: Optional[FigmaContext] = None
    error: Optional[str] = None


# --- Figma Socket.IO Server Logic ---
async def start_socketio_server():
    global sio_server, figma_app, connected_figma_client_sid

    if sio_server:
        logger.info("Figma Socket.IO server is already running.")
        return

    sio_server = socketio.AsyncServer(async_mode='aiohttp', cors_allowed_origins='*')
    figma_app = web.Application()
    sio_server.attach(figma_app)

    @sio_server.event
    async def connect(sid, environ):
        global connected_figma_client_sid
        logger.info(f"Figma client connected: {sid}")
        if connected_figma_client_sid and connected_figma_client_sid != sid:
            logger.info(f"Disconnecting previous Figma client: {connected_figma_client_sid}")
            await sio_server.disconnect(connected_figma_client_sid)
        connected_figma_client_sid = sid
        # In a VS Code extension, you'd update the status bar here
        # For now, just log
        logger.info(f"Figma Connection Status: Connected ({sid})")


    @sio_server.event
    async def disconnect(sid):
        global connected_figma_client_sid
        logger.info(f"Figma client disconnected: {sid}")
        if connected_figma_client_sid == sid:
            connected_figma_client_sid = None
            # Cancel pending requests
            for req_id, (fut, timer) in list(figma_context_requests.items()):
                timer.cancel()
                if not fut.done():
                    fut.set_exception(RuntimeError(f"Figma plugin disconnected before response for {req_id}"))
                del figma_context_requests[req_id]
            logger.info("Figma Connection Status: Disconnected")

    @sio_server.on('context_response')
    async def on_context_response(sid, data: Dict):
        logger.info(f"Received 'context_response' from {sid} for requestId: {data.get('requestId')}")
        try:
            response_data = ContextResponsePayload(**data) # Validate with Pydantic
            request_id = response_data.requestId
            if request_id in figma_context_requests:
                fut, timer = figma_context_requests.pop(request_id)
                timer.cancel()
                if not fut.done():
                    if response_data.error:
                        fut.set_exception(RuntimeError(response_data.error))
                    elif response_data.payload:
                        fut.set_result(response_data.payload)
                    else:
                        fut.set_exception(RuntimeError("Invalid context_response from Figma"))
            else:
                logger.warning(f"Received context_response for unknown or timed-out requestId: {request_id}")
        except Exception as e: # Catch Pydantic validation errors or others
            logger.error(f"Error processing context_response: {e}, data: {data}")


    runner = web.AppRunner(figma_app)
    await runner.setup()
    site = web.TCPSite(runner, 'localhost', FIGMA_SOCKET_IO_PORT)
    try:
        await site.start()
        logger.info(f"Figma Socket.IO server listening on port {FIGMA_SOCKET_IO_PORT}")
    except OSError as e:
        logger.error(f"Failed to start Figma Socket.IO server on port {FIGMA_SOCKET_IO_PORT}: {e}")
        # In VS Code, show error message
        raise # Re-raise to be caught by activation logic

async def stop_socketio_server():
    global sio_server, connected_figma_client_sid
    logger.info("Stopping Figma Socket.IO server...")
    if sio_server:
        # Disconnect any connected client
        if connected_figma_client_sid:
            try:
                await sio_server.disconnect(connected_figma_client_sid)
            except Exception as e:
                logger.warning(f"Error disconnecting Figma client: {e}")
        # Cancel all pending requests
        for req_id, (fut, timer) in list(figma_context_requests.items()):
            timer.cancel()
            if not fut.done():
                fut.set_exception(RuntimeError("Figma Socket.IO server shutting down."))
            del figma_context_requests[req_id]

        # Note: python-socketio's AsyncServer doesn't have an explicit close.
        # Stopping the underlying aiohttp server is the way.
        # We don't have a direct reference to the runner/site here to stop it,
        # so this part needs to be managed by the main activation/deactivation logic
        # that holds the runner.
        sio_server = None
        connected_figma_client_sid = None
    logger.info("Figma Socket.IO server state cleared.")


# --- MCP Server (HTTP/SSE for Cline) ---
async def handle_mcp_sse(request: web.Request) -> web.StreamResponse:
    global mcp_server_instance, mcp_sse_clients, mcp_client_message_queues
    session_id = str(uuid.uuid4())
    logger.info(f"New MCP SSE connection request. Assigning sessionId: {session_id}")

    # Prepare SSE response
    response = web.StreamResponse(
        status=200,
        reason='OK',
        headers={'Content-Type': 'text/event-stream',
                 'Cache-Control': 'no-cache',
                 'Connection': 'keep-alive'}
    )
    await response.prepare(request)
    mcp_sse_clients[session_id] = response
    mcp_client_message_queues[session_id] = asyncio.Queue()

    # Create a transport-like interface for the Python MCP SDK
    # The Python SDK's SSE transport is usually for the *client* side.
    # For the server side with SSE, we need to manage message passing manually.

    async def send_to_client(message: Dict):
        if session_id in mcp_sse_clients:
            try:
                sse_client_response = mcp_sse_clients[session_id]
                if not sse_client_response.prepared or sse_client_response.closed:
                    logger.warning(f"SSE client {session_id} is closed or not prepared. Cannot send.")
                    # Clean up if client is gone
                    if session_id in mcp_sse_clients: del mcp_sse_clients[session_id]
                    if session_id in mcp_client_message_queues: del mcp_client_message_queues[session_id]
                    return

                # Ensure message is JSON serializable
                json_message = json.dumps(message)
                await sse_client_response.write(f"data: {json_message}\n\n".encode('utf-8'))
                # logger.debug(f"Sent to MCP client {session_id}: {json_message[:100]}...") # Log snippet
            except ConnectionResetError:
                logger.warning(f"Connection reset by MCP client {session_id}. Cleaning up.")
                if session_id in mcp_sse_clients: del mcp_sse_clients[session_id]
                if session_id in mcp_client_message_queues: del mcp_client_message_queues[session_id]
            except Exception as e:
                logger.error(f"Error sending message to MCP client {session_id}: {e}")
        else:
            logger.warning(f"Attempted to send to non-existent MCP client session: {session_id}")


    async def receive_from_client() -> Optional[Dict]:
        if session_id in mcp_client_message_queues:
            try:
                # Wait for a message from the POST handler
                message = await mcp_client_message_queues[session_id].get()
                mcp_client_message_queues[session_id].task_done()
                return message
            except asyncio.CancelledError:
                logger.info(f"Receive task cancelled for MCP client {session_id}")
                return None # Or re-raise
            except Exception as e:
                logger.error(f"Error receiving message for MCP client {session_id}: {e}")
                return None
        return None


    if mcp_server_instance:
        logger.info(f"Connecting MCP server logic to transport for session {session_id}")
        # The Python SDK's Server.run() expects readable/writable streams.
        # We need to adapt. We'll run the MCP Server's main loop for this session.
        # This part is tricky as mcp.server.Server.run isn't designed for per-request invocation with SSE.
        # A more robust solution might involve a custom transport for the Python SDK.
        # For now, we'll manually handle the `initialize` handshake and then process messages.

        try:
            # Send initialize response (this is typically done by the SDK's transport)
            # We need to construct what the server would send.
            # This is a simplified version. A real implementation would use mcp_server_instance.create_initialization_options()
            # and mcp_server_instance._protocol.generate_initialize_result() if those were public/usable.
            init_response = {
                "jsonrpc": "2.0",
                "id": "init_hack", # Client should send an ID for initialize
                "result": {
                    "capabilities": mcp_server_instance.capabilities.model_dump(exclude_none=True),
                    "serverInfo": mcp_server_instance.server_info.model_dump(exclude_none=True)
                }
            }
            # Wait for client's initialize request first (comes via POST)
            client_init_request = await mcp_client_message_queues[session_id].get()
            mcp_client_message_queues[session_id].task_done()

            if client_init_request and client_init_request.get("method") == "initialize":
                init_response["id"] = client_init_request.get("id") # Use client's ID
                await send_to_client(init_response)
                logger.info(f"Sent initialize response to MCP client {session_id}")

                # Send 'initialized' notification from server (client expects this)
                await send_to_client({
                    "jsonrpc": "2.0",
                    "method": "initialized",
                    "params": {}
                })
                logger.info(f"Sent initialized notification to MCP client {session_id}")


            # Main message loop for this client
            while session_id in mcp_sse_clients and mcp_sse_clients[session_id].prepared and not mcp_sse_clients[session_id].closed:
                incoming_message = await receive_from_client()
                if incoming_message is None: # Queue closed or error
                    break
                if incoming_message:
                    logger.info(f"MCP client {session_id} sent: {str(incoming_message)[:200]}...")
                    # This is where mcp_server_instance.process_message(incoming_message, send_fn) would be ideal
                    # but process_message is not a public API of mcp.server.Server.
                    # We need to simulate the request handling.
                    response_message = await mcp_server_instance.handle_request(incoming_message)
                    if response_message:
                        await send_to_client(response_message)
        except asyncio.CancelledError:
            logger.info(f"SSE connection task cancelled for {session_id}.")
        except Exception as e:
            logger.error(f"Error in MCP SSE handler for {session_id}: {e}")
        finally:
            logger.info(f"Cleaning up MCP SSE connection for {session_id}")
            if session_id in mcp_sse_clients: del mcp_sse_clients[session_id]
            if session_id in mcp_client_message_queues:
                # Drain and signal queue closure if needed
                q = mcp_client_message_queues.pop(session_id)
                while not q.empty():
                    try: q.get_nowait()
                    except asyncio.QueueEmpty: break
                    q.task_done()

    return response

async def handle_mcp_message_post(request: web.Request) -> web.Response:
    session_id = request.query.get("sessionId")
    if not session_id or session_id not in mcp_client_message_queues:
        logger.warning(f"Received MCP POST for invalid/unknown sessionId: {session_id}")
        return web.Response(text="Not Found: Invalid or expired session", status=404)

    try:
        message_data = await request.json() # Expects JSON-RPC message
        logger.info(f"Received MCP POST for {session_id}: {str(message_data)[:100]}...")
        await mcp_client_message_queues[session_id].put(message_data)
        return web.Response(text="OK", status=200)
    except json.JSONDecodeError:
        logger.error(f"Invalid JSON in MCP POST for {session_id}")
        return web.Response(text="Bad Request: Invalid JSON", status=400)
    except Exception as e:
        logger.error(f"Error handling MCP POST for {session_id}: {e}")
        return web.Response(text="Internal Server Error", status=500)


async def get_figma_context_tool_handler(
    latitude: Optional[float] = None, # Example of how tool args would be defined if needed
    longitude: Optional[float] = None
) -> List[mcp_types.ContentPart]: # Return type for MCP tools
    global connected_figma_client_sid, sio_server
    logger.info("MCP tool 'get_figma_context' called.")

    if not connected_figma_client_sid or not sio_server:
        logger.error("Figma plugin not connected for MCP tool call.")
        raise mcp_server.ToolError("Figma plugin is not connected.") # SDK handles formatting this

    request_id = f"figma-ctx-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    # Set a timeout for the Figma request
    timeout_handle = loop.call_later(30, lambda: None if fut.done() else fut.set_exception(
        TimeoutError("Request to Figma plugin timed out (30 seconds).")
    ))
    figma_context_requests[request_id] = (fut, timeout_handle)

    try:
        logger.info(f"Emitting 'request_context' (requestId: {request_id}) to Figma client {connected_figma_client_sid}")
        await sio_server.emit('request_context', {'requestId': request_id}, to=connected_figma_client_sid)

        context_payload: FigmaContext = await asyncio.wait_for(fut, timeout=31) # slightly more than call_later
        logger.info(f"Successfully received context for request {request_id}.")

        # --- Save SVG Assets ---
        asset_results = {"savedFiles": [], "errors": []}
        # In VS Code extension, you get workspace_path. For standalone, define a base path or make it configurable.
        # For this example, let's assume a local 'workspace/assets/svg' directory.
        workspace_base_path = Path.cwd() / "mcp_workspace" # Define your workspace path
        if context_payload.assets:
            asset_results = await save_svg_assets_py(context_payload.assets, workspace_base_path)
            logger.info(f"SVG Asset saving: {len(asset_results['savedFiles'])} saved, {len(asset_results['errors'])} errors.")

        # --- Build MCP Content Parts ---
        mcp_content_parts: List[mcp_types.ContentPart] = []

        if context_payload.image:
             # Assuming image is base64 PNG
            mcp_content_parts.append(mcp_types.ImageContent(type="image", data=context_payload.image, mimeType="image/png"))

        text_details = f"""
Figma Context Details:

Prompt Suggestion:
{context_payload.prompt}

Technology Configuration:
```json
{json.dumps(context_payload.tech_config, indent=2)}
