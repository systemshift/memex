"""First-run onboarding prompt for new users."""

from .chat import SYSTEM_PROMPT

ONBOARDING_ADDENDUM = """

IMPORTANT: This is the user's first time using memex. Follow these steps:

1. Start by calling `dagit_whoami` to look up the user's decentralized identity (DID).
2. Welcome the user and show them their DID.
3. Explain memex in 2 sentences: it's a personal knowledge graph where you can save thoughts, notes, and connections — paired with a decentralized social network (dagit) where you can publish and share using your cryptographic identity.
4. Ask the user for their first thought, idea, or note they'd like to save.
5. When they provide one, save it using `memex_create_node` with type "Note".
6. After saving, suggest they post an introduction to dagit using `dagit_post` — something like "Hello from memex! My first note: ..."

Be warm, concise, and encouraging. This is their first experience — make it count."""


def get_system_prompt(first_run: bool) -> str:
    """Return system prompt, with onboarding addendum if first run."""
    if first_run:
        return SYSTEM_PROMPT + ONBOARDING_ADDENDUM
    return SYSTEM_PROMPT
