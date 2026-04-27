from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
METADATA_PATH = BASE_DIR / "metadata.json"
ALLOWED_EXT = {".py", ".bat", ".cmd", ".ps1"}
MAX_UPLOAD_SIZE = 5 * 1024 * 1024


@dataclass
class Config:
    port: int
    root_dir: Path
    allowed_ips: list[str]
    openai_base_url: str
    openai_api_key: str
    openai_model: str
    openai_timeout_ms: int


def load_config() -> Config:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"配置文件不存在: {CONFIG_PATH}")
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    allowed_ips = [str(x).strip() for x in (raw.get("allowedIps") or []) if str(x).strip()]
    if not allowed_ips:
        raise RuntimeError("配置文件中 allowedIps 不能为空")

    port_raw = int(raw.get("port", 8787))
    port = port_raw if 0 < port_raw <= 65535 else 8787
    root_raw = str(raw.get("rootDir") or "").strip()
    root_dir = Path(root_raw if root_raw else str(Path.cwd() / "tasks")).resolve()

    base_url = str(raw.get("openaiBaseUrl") or "").strip().rstrip("/")
    api_key = str(raw.get("openaiApiKey") or "").strip()
    model = str(raw.get("openaiModel") or "").strip()
    timeout_ms = max(1000, int(raw.get("openaiTimeoutSec", 20)) * 1000)
    return Config(
        port=port,
        root_dir=root_dir,
        allowed_ips=allowed_ips,
        openai_base_url=base_url,
        openai_api_key=api_key,
        openai_model=model,
        openai_timeout_ms=timeout_ms,
    )


CONFIG = load_config()


def normalize_ip(raw: str) -> str:
    ip = (raw or "").strip()
    if ip.startswith("::ffff:"):
        return ip[7:]
    return ip


def read_metadata() -> dict[str, dict[str, Any]]:
    if not METADATA_PATH.exists():
        return {}
    try:
        value = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    return {}


def write_metadata(meta: dict[str, dict[str, Any]]) -> None:
    METADATA_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_name(file_name: str) -> str:
    value = str(file_name or "").strip()
    if not value:
        raise ValueError("fileName is required")
    if "/" in value or "\\" in value or ".." in value:
        raise ValueError("invalid fileName")
    if Path(value).suffix.lower() not in ALLOWED_EXT:
        raise ValueError("unsupported script extension")
    return value


def safe_path(file_name: str) -> Path:
    name = safe_name(file_name)
    abs_path = (CONFIG.root_dir / name).resolve()
    try:
        abs_path.relative_to(CONFIG.root_dir)
    except ValueError as exc:
        raise ValueError("invalid target path") from exc
    return abs_path


def short_summary(text: str) -> str:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if not normalized:
        return "暂无简介"
    return normalized[:24]


def fallback_summary(file_name: str, content: str) -> str:
    lines = [x.strip() for x in str(content or "").splitlines() if x.strip()]
    comment = next((x for x in lines if x.startswith("#") or x.startswith("//") or x.upper().startswith("REM ")), "")
    if comment:
        comment = re.sub(r"^(#|//|REM\s+)", "", comment, flags=re.IGNORECASE).strip()
        return short_summary(comment)
    return short_summary(f"脚本 {file_name}，用于自动化任务执行")


def ai_summary(file_name: str, content: str) -> str:
    cfg = CONFIG
    if not (cfg.openai_base_url and cfg.openai_api_key and cfg.openai_model):
        return fallback_summary(file_name, content)
    payload = {
        "model": cfg.openai_model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "你是脚本仓库助手。请生成一句中文简介，约20字，准确概括脚本用途；不要包含引号、序号或多余前缀。",
            },
            {"role": "user", "content": f"脚本名: {file_name}\n脚本内容片段:\n{str(content)[:4000]}"},
        ],
    }
    req = urlrequest.Request(
        url=f"{cfg.openai_base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {cfg.openai_api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=cfg.openai_timeout_ms / 1000) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            value = (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )
            cleaned = re.sub(r'^[\"\']|[\"\']$', "", str(value).replace("\n", " ").strip())
            result = short_summary(cleaned)
            return result or fallback_summary(file_name, content)
    except (urlerror.URLError, TimeoutError, ValueError, KeyError, IndexError):
        return fallback_summary(file_name, content)


def openai_chat(system_prompt: str, user_prompt: str) -> str:
    cfg = CONFIG
    if not (cfg.openai_base_url and cfg.openai_api_key and cfg.openai_model):
        return ""
    payload = {
        "model": cfg.openai_model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = urlrequest.Request(
        url=f"{cfg.openai_base_url}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {cfg.openai_api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=cfg.openai_timeout_ms / 1000) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            value = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return str(value or "").strip()
    except (urlerror.URLError, TimeoutError, ValueError, KeyError, IndexError):
        return ""


def extract_schema_from_script(content: str) -> dict[str, dict[str, Any]]:
    schema: dict[str, dict[str, Any]] = {}
    lines = content.splitlines()
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        if "add_argument(" in line or "click.option(" in line or "@click.option" in line:
            for flag in re.findall(r"""['"]--([a-zA-Z0-9][\w-]*)['"]""", line):
                key = flag.replace("-", "_")
                arg_type = "string"
                low = line.lower()
                if "type=int" in low or "type = int" in low or "type=float" in low:
                    arg_type = "number"
                elif "store_true" in low or "bool" in low:
                    arg_type = "boolean"
                elif "choices=" in low:
                    arg_type = "enum"
                item: dict[str, Any] = {"type": arg_type}
                if re.search(r"required\s*=\s*true", low):
                    item["required"] = True
                m_help = re.search(r"""help\s*=\s*['"]([^'"]+)['"]""", line, flags=re.IGNORECASE)
                if m_help:
                    item["description"] = m_help.group(1).strip()
                schema[key] = item

        for flag in re.findall(r"""(?:^|\s)--([a-zA-Z0-9][\w-]*)""", line):
            key = flag.replace("-", "_")
            if key not in schema:
                schema[key] = {"type": "string"}
    return schema


def normalize_schema_item(v: Any) -> dict[str, Any] | None:
    if not isinstance(v, dict):
        return None
    arg_type = v.get("type")
    if arg_type not in ("string", "number", "boolean", "enum"):
        arg_type = "string"
    out: dict[str, Any] = {"type": arg_type}
    if isinstance(v.get("required"), bool):
        out["required"] = v["required"]
    if "default" in v:
        out["default"] = v["default"]
    if isinstance(v.get("description"), str) and v["description"].strip():
        out["description"] = v["description"].strip()
    if isinstance(v.get("enumValues"), list):
        out["enumValues"] = [str(x).strip() for x in v["enumValues"] if str(x).strip()]
    return out


def ai_generate_schema(file_name: str, content: str) -> dict[str, dict[str, Any]]:
    raw = openai_chat(
        "你是脚本参数标准化助手。输出 JSON 对象，键是参数名，值是 {type,required,default,description,enumValues}。type 只能是 string/number/boolean/enum。",
        f"脚本名: {file_name}\n请提取或推断可配置参数。\n脚本内容:\n{content[:8000]}",
    )
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    schema: dict[str, dict[str, Any]] = {}
    for k, v in parsed.items():
        key = str(k).strip().replace("-", "_")
        if not key:
            continue
        item = normalize_schema_item(v)
        if item:
            schema[key] = item
    return schema


def list_scripts() -> list[dict[str, Any]]:
    if not CONFIG.root_dir.exists():
        return []
    metadata = read_metadata()
    out: list[dict[str, Any]] = []
    for p in sorted(CONFIG.root_dir.iterdir(), key=lambda x: x.name):
        if not p.is_file() or p.suffix.lower() not in ALLOWED_EXT:
            continue
        stat = p.stat()
        m = metadata.get(p.name, {})
        summary = str(m.get("summary") or "").strip() or "暂无简介"
        out.append(
            {
                "fileName": p.name,
                "summary": summary,
                "size": stat.st_size,
                "updatedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
    return out


class UploadBody(BaseModel):
    fileName: str
    overwrite: bool = False
    contentBase64: str


app = FastAPI()


@app.middleware("http")
async def whitelist_ip(request: Request, call_next):
    client_host = normalize_ip(request.client.host if request.client else "")
    if client_host not in CONFIG.allowed_ips:
        return JSONResponse(status_code=403, content={"error": "forbidden: ip not in whitelist"})
    return await call_next(request)


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, str) else "request failed"
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


@app.exception_handler(Exception)
async def all_exception_handler(_: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)})


@app.get("/health")
async def health():
    return {
        "ok": True,
        "rootDir": str(CONFIG.root_dir),
        "allowedIps": CONFIG.allowed_ips,
        "aiConfigured": bool(CONFIG.openai_base_url and CONFIG.openai_api_key and CONFIG.openai_model),
    }


@app.get("/api/scripts")
async def api_scripts():
    return {"items": list_scripts()}


@app.get("/api/scripts/download")
async def api_scripts_download(fileName: str):
    try:
        abs_path = safe_path(fileName)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="script not found")
    return FileResponse(path=abs_path, filename=fileName, media_type="application/octet-stream")


@app.post("/api/scripts/upload")
async def api_scripts_upload(body: UploadBody):
    try:
        file_name = safe_name(body.fileName)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not body.contentBase64:
        raise HTTPException(status_code=400, detail="contentBase64 is required")
    try:
        content = base64.b64decode(body.contentBase64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="contentBase64 is invalid") from exc

    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail=f"script is too large: {len(content)} bytes")

    try:
        abs_path = safe_path(file_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    existed = abs_path.exists()
    if existed and not body.overwrite:
        raise HTTPException(status_code=409, detail="script already exists")

    CONFIG.root_dir.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(content)

    text_content = content.decode("utf-8", errors="ignore")
    summary = ai_summary(file_name, text_content)
    schema = extract_schema_from_script(text_content)
    schema_source = "parser"
    standardized = bool(schema)

    if not standardized and (CONFIG.openai_base_url and CONFIG.openai_api_key and CONFIG.openai_model):
        ai_schema = ai_generate_schema(file_name, text_content)
        if ai_schema:
            schema = ai_schema
            schema_source = "ai"
            standardized = True

    metadata = read_metadata()
    metadata[file_name] = {
        "summary": summary,
        "size": len(content),
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "standardized": standardized,
        "schemaSource": schema_source,
        "argsSchema": schema,
    }
    write_metadata(metadata)

    return {
        "uploaded": True,
        "fileName": file_name,
        "summary": summary,
        "size": len(content),
        "overwritten": bool(existed and body.overwrite),
        "standardized": standardized,
        "schemaSource": schema_source,
        "argsSchema": schema,
    }
