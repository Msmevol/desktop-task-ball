from __future__ import annotations

import uvicorn

from server import CONFIG, app


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=CONFIG.port, log_level="info")


if __name__ == "__main__":
    main()
