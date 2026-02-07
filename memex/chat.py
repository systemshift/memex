"""Chat panel widget for Memex."""

import asyncio
import json
from typing import Callable, Awaitable

from textual.widgets import RichLog
from rich.markdown import Markdown
from rich.text import Text

from .provider import ChatProvider, Chunk, ToolCall
from .tools import get_all_tools, execute_tool, ingest_conversation_turn, load_recent_conversations


SYSTEM_PROMPT = """You are Memex, a personal knowledge workstation. Everything the user says is automatically saved to their knowledge graph — they don't need to ask you to remember anything. You are the memory.

You have two systems:
- **memex** (private): The user's knowledge graph. Notes, entities, relationships, raw sources — all stored locally.
- **dagit** (public): A decentralized social network. Posts are signed with the user's cryptographic key and published to IPFS. Only post when the user explicitly asks.

Tools — Knowledge Graph:
- memex_search: Full-text search across all nodes
- memex_get_node: Get a node by ID
- memex_get_links: Get relationships for a node
- memex_traverse: Walk the graph from a starting node
- memex_filter: Filter nodes by type
- memex_create_node: Create a new node (Note, Person, Concept, Document, etc.)
- memex_create_link: Create a relationship between two nodes
- memex_update_node: Update a node's metadata
- memex_ingest: Ingest raw content as a content-addressed Source node (SHA256 dedup)

Tools — Social Network:
- dagit_post: Publish a signed post to IPFS (only when the user asks to share)
- dagit_read: Read posts from the network
- dagit_whoami: Show the user's decentralized identity (DID)

Behavior:
- Every conversation turn is automatically ingested into the graph. You have memory across sessions.
- When the user mentions people, concepts, or ideas, proactively create nodes and links to build their knowledge graph.
- Search the graph before answering questions — the answer may already be in their memory.
- Be concise. The user is working, not chatting."""


class ChatEngine:
    """Manages chat state and model interactions.

    Conversations are automatically ingested into the knowledge graph after
    each turn, making memex the persistent desktop memory. On startup,
    recent conversation history is loaded from the graph so the LLM has
    context across sessions.
    """

    def __init__(self, first_run: bool = False):
        self.provider = ChatProvider()
        self.messages: list[dict] = []
        self.tools = get_all_tools()
        self.first_run = first_run
        self._tool_names_this_turn: list[str] = []
        self._memory_loaded = False

    def _load_memory_sync(self) -> None:
        """Load previous conversation memory from the graph (sync, call from thread)."""
        if self._memory_loaded or self.first_run:
            return
        prior = load_recent_conversations(limit=20)
        if prior:
            self.messages[:0] = prior  # prepend
        self._memory_loaded = True

    async def load_memory(self) -> None:
        """Load conversation memory without blocking the event loop."""
        await asyncio.to_thread(self._load_memory_sync)

    async def send(
        self,
        user_input: str,
        on_text: Callable[[str], Awaitable[None]],
        on_tool: Callable[[str], Awaitable[None]],
    ) -> None:
        """Send a message and stream the response.

        Args:
            user_input: User's message
            on_text: Callback for text chunks
            on_tool: Callback for tool call notifications
        """
        self.messages.append({"role": "user", "content": user_input})
        self._tool_names_this_turn = []

        from .onboarding import get_system_prompt
        system_prompt = get_system_prompt(self.first_run)

        # First request uses full message history
        prev_id = None

        max_turns = 10
        for _ in range(max_turns):
            text_buffer = ""
            tool_calls: list[ToolCall] = []

            # On first iteration, send full messages. On tool-result iterations,
            # send tool outputs with previous_response_id.
            if prev_id is None:
                input_msgs = self.messages
            else:
                input_msgs = self._pending_tool_outputs

            async for chunk in self.provider.stream(
                system_prompt, input_msgs, self.tools,
                previous_response_id=prev_id,
            ):
                if chunk.type == "text":
                    await on_text(chunk.text)
                    text_buffer += chunk.text

                elif chunk.type == "tool_call":
                    tool_calls.append(chunk.tool_call)
                    self._tool_names_this_turn.append(chunk.tool_call.name)
                    await on_tool(f"[{chunk.tool_call.name}]")

                elif chunk.type == "error":
                    await on_text(f"\nError: {chunk.error}")
                    return

            # If there were tool calls, execute them and send results back
            if tool_calls:
                prev_id = self.provider.last_response_id
                self._pending_tool_outputs = []

                for tc in tool_calls:
                    result = await asyncio.to_thread(execute_tool, tc.name, tc.arguments)
                    self._pending_tool_outputs.append({
                        "type": "function_call_output",
                        "call_id": tc.call_id,
                        "output": result,
                    })
                continue

            # No tool calls - conversation turn complete
            if text_buffer:
                self.messages.append({"role": "assistant", "content": text_buffer})

                # Auto-ingest in background thread — don't block the UI
                asyncio.get_event_loop().run_in_executor(
                    None,
                    ingest_conversation_turn,
                    user_input,
                    text_buffer,
                    self._tool_names_this_turn or None,
                )
            return

    def clear(self) -> None:
        """Clear conversation history."""
        self.messages.clear()


class ChatPanel(RichLog):
    """Chat display panel with rich formatting."""

    def __init__(self, **kwargs):
        super().__init__(markup=True, wrap=True, **kwargs)

    def add_user_message(self, text: str) -> None:
        """Add a user message to the display."""
        self.write(Text.from_markup(f"[bold cyan]You:[/bold cyan] {text}"))

    def add_assistant_response(self, text: str) -> None:
        """Add a complete assistant response as a single block."""
        self.write(Text.from_markup(f"[bold green]Memex:[/bold green] {text}"))

    def add_tool_indicator(self, tool_name: str) -> None:
        """Show a tool being called."""
        self.write(Text.from_markup(f"[dim]{tool_name}[/dim]"))

    def add_error(self, error: str) -> None:
        """Display an error message."""
        self.write(Text.from_markup(f"[bold red]Error:[/bold red] {error}"))

    def add_system_message(self, text: str) -> None:
        """Display a system message."""
        self.write(Text.from_markup(f"[dim italic]{text}[/dim italic]"))
