"""Chat panel widget for Memex."""

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

        # Load previous conversation memory from the graph
        if not first_run:
            prior = load_recent_conversations(limit=20)
            if prior:
                self.messages.extend(prior)

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

        max_turns = 10
        for _ in range(max_turns):
            text_buffer = ""
            tool_calls: list[ToolCall] = []

            from .onboarding import get_system_prompt
            system_prompt = get_system_prompt(self.first_run)

            for chunk in self.provider.stream(
                system_prompt, self.messages, self.tools
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

            # If there were tool calls, execute them and continue
            if tool_calls:
                # Add assistant message with tool calls
                self.messages.append(
                    {
                        "role": "assistant",
                        "content": text_buffer or None,
                        "tool_calls": [
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": json.dumps(tc.arguments),
                                },
                            }
                            for tc in tool_calls
                        ],
                    }
                )

                # Execute tools and add results
                for tc in tool_calls:
                    result = execute_tool(tc.name, tc.arguments)
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": result,
                        }
                    )
                continue

            # No tool calls - conversation turn complete
            if text_buffer:
                self.messages.append({"role": "assistant", "content": text_buffer})

                # Auto-ingest this conversation turn into the knowledge graph
                ingest_conversation_turn(
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

    def add_assistant_text(self, text: str) -> None:
        """Add assistant text (streaming)."""
        # For streaming, we append to the current line
        self.write(text, scroll_end=True)

    def start_assistant_response(self) -> None:
        """Start a new assistant response line."""
        self.write(Text.from_markup("[bold green]Memex:[/bold green] "), scroll_end=True)

    def add_tool_indicator(self, tool_name: str) -> None:
        """Show a tool being called."""
        self.write(Text.from_markup(f"[dim]{tool_name}[/dim]"))

    def add_error(self, error: str) -> None:
        """Display an error message."""
        self.write(Text.from_markup(f"[bold red]Error:[/bold red] {error}"))

    def add_system_message(self, text: str) -> None:
        """Display a system message."""
        self.write(Text.from_markup(f"[dim italic]{text}[/dim italic]"))
