import logging
import os
from dataclasses import dataclass
from typing import Set

import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

load_dotenv()

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("tg-python-bot")


def _parse_chat_ids(raw: str) -> Set[int]:
    values: Set[int] = set()
    for part in (raw or "").split(","):
        item = part.strip()
        if not item:
            continue
        try:
            values.add(int(item))
        except ValueError:
            logger.warning("Skip invalid TG_ALLOWED_CHAT_IDS value: %s", item)
    return values


@dataclass(frozen=True)
class Settings:
    tg_bot_token: str
    allowed_chat_ids: Set[int]
    gh_owner: str
    gh_repo: str
    gh_workflow_file: str
    gh_ref: str
    gh_token: str

    @property
    def workflow_page(self) -> str:
        return (
            f"https://github.com/{self.gh_owner}/{self.gh_repo}/actions/workflows/"
            f"{self.gh_workflow_file}"
        )


def load_settings() -> Settings:
    return Settings(
        tg_bot_token=os.getenv("TG_BOT_TOKEN", "").strip(),
        allowed_chat_ids=_parse_chat_ids(os.getenv("TG_ALLOWED_CHAT_IDS", "")),
        gh_owner=os.getenv("GH_OWNER", "").strip(),
        gh_repo=os.getenv("GH_REPO", "").strip(),
        gh_workflow_file=os.getenv("GH_WORKFLOW_FILE", "source-monitor-telegram.yml").strip(),
        gh_ref=os.getenv("GH_REF", "main").strip(),
        gh_token=os.getenv("GH_TOKEN", "").strip(),
    )


SETTINGS = load_settings()


def is_chat_allowed(chat_id: int) -> bool:
    if not SETTINGS.allowed_chat_ids:
        return True
    return chat_id in SETTINGS.allowed_chat_ids


def get_first_command_token(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""

    first = raw.split()[0].lower()
    if not first.startswith("/"):
        return ""

    at_idx = first.find("@")
    return first if at_idx == -1 else first[:at_idx]


async def dispatch_workflow(trigger_text: str | None = None) -> tuple[bool, str]:
    if not SETTINGS.gh_owner or not SETTINGS.gh_repo or not SETTINGS.gh_token:
        return False, "Missing GH_OWNER/GH_REPO/GH_TOKEN in env."

    url = (
        f"https://api.github.com/repos/{SETTINGS.gh_owner}/{SETTINGS.gh_repo}"
        f"/actions/workflows/{SETTINGS.gh_workflow_file}/dispatches"
    )
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {SETTINGS.gh_token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    payload = {"ref": SETTINGS.gh_ref}
    if trigger_text:
        payload["inputs"] = {"trigger_text": trigger_text}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            res = await client.post(url, headers=headers, json=payload)
    except Exception as exc:  # noqa: BLE001
        return False, f"GitHub API connection error: {exc}"

    if res.status_code == 204:
        return True, "OK"

    body = res.text.strip()
    if len(body) > 500:
        body = body[:500] + "..."
    return False, f"GitHub API {res.status_code}: {body or 'No response body'}"


async def help_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_chat or not update.message:
        return

    chat_id = update.effective_chat.id
    if not is_chat_allowed(chat_id):
        return

    text = (
        "Lenh ho tro:\n"
        "/run - Kich hoat monitor workflow ngay\n"
        "/check - Alias cua /run\n"
        "/test - Alias cua /run\n"
        "/status - Xem trang workflow\n"
        "\n"
        "Luu y: Bot nay chi trigger workflow. Report se do workflow gui ve Telegram."
    )
    await update.message.reply_text(text)


async def status_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_chat or not update.message:
        return

    chat_id = update.effective_chat.id
    if not is_chat_allowed(chat_id):
        return

    await update.message.reply_text(
        "Trang workflow:\n" + SETTINGS.workflow_page,
        disable_web_page_preview=True,
    )


async def run_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_chat or not update.message:
        return

    chat_id = update.effective_chat.id
    if not is_chat_allowed(chat_id):
        await update.message.reply_text("Chat nay khong duoc phep su dung bot.")
        return

    command_token = get_first_command_token(update.message.text) or "/run"
    await update.message.reply_text(f"Da nhan lenh {command_token}\nDang chay source monitor...")

    ok, detail = await dispatch_workflow(f"telegram_command {command_token}")
    if not ok:
        await update.message.reply_text("Trigger that bai:\n" + detail)


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.exception("Unhandled exception", exc_info=context.error)


def main() -> None:
    if not SETTINGS.tg_bot_token:
        raise RuntimeError("Missing TG_BOT_TOKEN")

    app = Application.builder().token(SETTINGS.tg_bot_token).build()

    app.add_handler(CommandHandler(["start", "help"], help_handler))
    app.add_handler(CommandHandler(["run", "check", "test"], run_handler))
    app.add_handler(CommandHandler(["status"], status_handler))
    app.add_error_handler(error_handler)

    logger.info("Bot started. Allowed chats: %s", SETTINGS.allowed_chat_ids or "ALL")
    app.run_polling(drop_pending_updates=False)


if __name__ == "__main__":
    main()
