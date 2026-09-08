"""Project-owned local processes. Run from any directory; never load .env."""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
BACKEND = ROOT / "services/backend"
PYTHON = BACKEND / ".venv/bin/python"
os.chdir(ROOT)


def command(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def pg_bin(name):
    found = shutil.which(name)
    if found:
        return found
    homebrew = Path("/opt/homebrew/opt/postgresql@18/bin") / name
    if homebrew.exists():
        return str(homebrew)
    raise SystemExit(f"缺少 {name}；请安装 PostgreSQL 18，或使用 make compose-bootstrap。")


def redis_bin(name):
    found = shutil.which(name)
    local = LOCAL / "bin" / name
    if found:
        return found
    if local.exists():
        return str(local)
    raise SystemExit("缺少 Redis 7.4；请安装 Redis，或使用 make compose-bootstrap。")


def verify_redis_owner(client):
    try:
        directory = client.config_get("dir").get("dir")
        if directory and Path(directory).resolve() == (LOCAL / "redis").resolve():
            return
    except Exception:
        pass
    raise SystemExit("56379 已被非本项目或无法核实归属的 Redis 占用；停止启动。")


def dependencies():
    LOCAL.mkdir(exist_ok=True)
    if not (LOCAL / "postgres/PG_VERSION").exists():
        command(
            [
                pg_bin("initdb"),
                "-D",
                LOCAL / "postgres",
                "-U",
                "shortfilm",
                "--auth=trust",
                "--encoding=UTF8",
                "--locale=C",
            ]
        )
    running = (
        subprocess.run(
            [pg_bin("pg_ctl"), "-D", str(LOCAL / "postgres"), "status"],
            stdout=subprocess.DEVNULL,
        ).returncode
        == 0
    )
    if not running:
        command(
            [
                pg_bin("pg_ctl"),
                "-D",
                LOCAL / "postgres",
                "-l",
                LOCAL / "postgres.log",
                "-o",
                "-h 127.0.0.1 -p 55432 -k /private/tmp",
                "start",
            ]
        )
    from psycopg import connect

    with connect(
        "host=127.0.0.1 port=55432 user=shortfilm dbname=postgres", autocommit=True
    ) as conn:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname='shortfilm'").fetchone():
            conn.execute("CREATE DATABASE shortfilm")
    (LOCAL / "redis").mkdir(exist_ok=True)
    from redis import Redis

    try:
        client = Redis(host="127.0.0.1", port=56379, decode_responses=True)
        client.ping()
    except Exception:
        command(
            [
                redis_bin("redis-server"),
                "--bind",
                "127.0.0.1",
                "--port",
                "56379",
                "--dir",
                LOCAL / "redis",
                "--appendonly",
                "yes",
                "--daemonize",
                "yes",
                "--pidfile",
                LOCAL / "redis.pid",
            ]
        )
    else:
        verify_redis_owner(client)


def bootstrap():
    dependencies()
    command(
        [
            BACKEND / ".venv/bin/alembic",
            "-c",
            BACKEND / "alembic.ini",
            "upgrade",
            "head",
        ]
    )
    command([PYTHON, "-m", "shortfilm.seed"])
    print("底座已就绪；运行 make dev。")


def dev():
    dependencies()
    import socket

    for port in (8010, 5180):
        with socket.socket() as probe:
            probe.settimeout(1)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise SystemExit(f"端口 {port} 已使用；请先检查现有服务，避免重复启动。")
    cmds = [
        [
            PYTHON,
            "-m",
            "uvicorn",
            "shortfilm.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8010",
            "--no-access-log",
        ],
        [
            PYTHON,
            "-m",
            "celery",
            "-A",
            "shortfilm.jobs.worker:celery",
            "worker",
            "--pool=solo",
            "-Q",
            "media",
            "-n",
            "media@%h",
            "--loglevel=WARNING",
        ],
        [
            PYTHON,
            "-m",
            "celery",
            "-A",
            "shortfilm.jobs.worker:celery",
            "worker",
            "--pool=solo",
            "-Q",
            "ai",
            "-n",
            "ai@%h",
            "--loglevel=WARNING",
        ],
        [PYTHON, "-m", "shortfilm.jobs.dispatcher"],
        ["npm", "run", "dev", "--prefix", "apps/web"],
    ]
    processes = []
    logs = []
    try:
        for name, cmd in zip(["api", "worker-media", "worker-ai", "dispatcher", "web"], cmds):
            log = (LOCAL / f"{name}.log").open("a")
            logs.append(log)
            processes.append(
                subprocess.Popen(
                    [str(a) for a in cmd],
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
            )
        print(
            "AI短片工坊 http://127.0.0.1:5180 · API http://127.0.0.1:8010/docs",
            flush=True,
        )
        while all(p.poll() is None for p in processes):
            time.sleep(1)
        raise SystemExit("一个应用进程已退出，请检查 .local 日志。")
    finally:
        for p in processes:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)
        for p in processes:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
        for log in logs:
            log.close()


def dev_deepseek():
    from getpass import getpass

    if not os.environ.get("DEEPSEEK_API_KEY"):
        value = getpass("DeepSeek API Key（隐藏输入，仅注入本次进程）: ").strip()
        if not value:
            raise SystemExit("没有输入密钥，未启动生成服务。")
        os.environ["DEEPSEEK_API_KEY"] = value
    dev()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["bootstrap", "dev", "dev_deepseek", "dependencies"])
    action = parser.parse_args().action
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        globals()[action]()
    except KeyboardInterrupt:
        pass
