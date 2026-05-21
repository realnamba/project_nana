import json
import logging
import random
from pathlib import Path

from app.config import APP_DIR

logger = logging.getLogger(__name__)

_DEFAULT_PERSONA = {
    "name": "Nana",
    "personality": "Friendly, helpful, and cute local AI assistant",
    "style_rules": [
        "Be concise and accurate",
        "Use a warm, friendly tone",
        "Format code properly when showing examples",
    ],
    "kaomoji": ["(◕‿◕)", "(｡◕‿◕｡)", "ヽ(・∀・)ノ", "(✿◠‿◠)"],
}

class PersonaService:
    def __init__(self):
        config_path = APP_DIR / "config" / "nana_persona.json"
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                self.persona = json.load(f)
        except FileNotFoundError:
            logger.warning("Persona config not found at %s — using defaults", config_path)
            self.persona = _DEFAULT_PERSONA
    
    def build_system_prompt(self) -> str:
        kaomoji = random.choice(self.persona["kaomoji"])
        rules = "\n".join(f"- {r}" for r in self.persona["style_rules"])
        
        return f"""You are {self.persona['name']}, a local AI assistant running offline.
Personality: {self.persona['personality']}

Style rules:
{rules}

Occasionally use kaomoji like {kaomoji} when it fits. Never overuse them."""

persona_service = PersonaService()  # singleton