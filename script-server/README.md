# Script Server

独立脚本服务端（Python + FastAPI），用于给桌面客户端提供脚本上传与下载能力，鉴权方式为 IP 白名单。

## 启动

```bash
pip install -r script-server/requirements.txt
npm run script-server:start
```

兼容说明：

- `npm run script-server:start`：启动 Python FastAPI 服务端（推荐）
- `npm run script-server:start:node`：启动旧版 Node 服务端（兼容保留）

## 配置文件

服务端读取 `script-server/config.json`，可参考 `script-server/config.example.json`：

```json
{
  "port": 8787,
  "rootDir": "../tasks",
  "allowedIps": ["127.0.0.1", "::1"],
  "openaiBaseUrl": "https://api.openai.com/v1",
  "openaiApiKey": "YOUR_API_KEY",
  "openaiModel": "gpt-4o-mini",
  "openaiTimeoutSec": 20
}
```

- `port`: 监听端口
- `rootDir`: 脚本存储目录（支持相对路径）
- `allowedIps`: IP 白名单（必填，至少 1 项）
- `openaiBaseUrl/openaiApiKey/openaiModel`: 上传后自动生成脚本简介所用的 OpenAI 兼容配置
- `openaiTimeoutSec`: 生成简介超时（秒）

## 接口

- `GET /health`
- `GET /api/scripts`
- `GET /api/scripts/download?fileName=example.py`
- `POST /api/scripts/upload`

`GET /api/scripts` 返回示例：

```json
{
  "items": [
    {
      "fileName": "example.py",
      "summary": "每日同步数据并输出执行结果",
      "size": 1024,
      "updatedAt": "2026-04-25T10:20:00.000Z"
    }
  ]
}
```

`POST /api/scripts/upload` 请求体（JSON）：

```json
{
  "fileName": "example.py",
  "overwrite": true,
  "contentBase64": "..."
}
```

`POST /api/scripts/upload` 返回示例（新增标准化结果）：

```json
{
  "uploaded": true,
  "fileName": "example.py",
  "summary": "用于巡检目标主机并输出结果",
  "size": 2048,
  "overwritten": false,
  "standardized": true,
  "schemaSource": "ai",
  "argsSchema": {
    "target": { "type": "string", "required": true, "description": "目标地址" },
    "timeout": { "type": "number", "default": 5, "description": "超时秒数" }
  }
}
```

## 安全约束

- 仅允许配置文件中的白名单 IP 访问（非白名单返回 `403`）
- 仅允许 `.py/.bat/.cmd/.ps1` 脚本
- 禁止路径穿越
- 上传大小限制为 `5MB`
- 上传后自动生成约 20 字简介并写入 `script-server/metadata.json`（AI 不可用时使用规则兜底）
- 上传后会先做参数标准化检测（argparse/click/--flag）；若未标准化且配置了 AI，会自动生成标准参数 schema
