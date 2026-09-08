PY := services/backend/.venv/bin/python
ALEMBIC := services/backend/.venv/bin/alembic -c services/backend/alembic.ini
.PHONY: bootstrap dev test contract check backup restore-check compose-bootstrap compose-dev
bootstrap:
	uv sync --project services/backend --frozen
	npm ci --prefix apps/web
	$(PY) scripts/local.py bootstrap
dev:
	$(PY) scripts/local.py dev
contract:
	$(PY) scripts/export-contract.py
	npm run contract --prefix apps/web
test:
	$(PY) scripts/test.py
	$(PY) scripts/check-contract.py
	npm run build --prefix apps/web
check:
	services/backend/.venv/bin/ruff check services/backend/src tests scripts
backup:
	$(PY) scripts/backup.py backup
restore-check:
	$(PY) scripts/backup.py restore-check
compose-bootstrap:
	docker compose -f infra/compose.yaml up -d postgres redis
	docker compose -f infra/compose.yaml run --build --rm migrate
compose-dev:
	docker compose -f infra/compose.yaml up --build -d
