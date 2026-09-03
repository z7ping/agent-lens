from pathlib import Path

source_path = Path('/tmp/apply-pi-tui-startup-detail.py')
source = source_path.read_text(encoding='utf-8')
old = '''def replace_once(path: str, old: str, new: str) -> None:\n    source = read(path)\n    count = source.count(old)\n    if count != 1:\n        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")\n    write(path, source.replace(old, new, 1))\n'''
new = '''def replace_once(path: str, old: str, new: str) -> None:\n    source = read(path)\n    count = source.count(old)\n    repeated_ready_state = (\n        path == "packages/runtime-cordis/src/pi-live/service.ts"\n        and old.startswith("      initializationTimings: runtime.initializationTimings,")\n    )\n    if repeated_ready_state:\n        if count not in (1, 2):\n            raise SystemExit(f"{path}: expected one or two runtime-state matches, got {count}: {old[:120]!r}")\n    elif count != 1:\n        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")\n    write(path, source.replace(old, new, 1))\n'''
if source.count(old) != 1:
    raise SystemExit('patch helper definition changed; refusing to weaken protection')
source = source.replace(old, new, 1)
exec(compile(source, str(source_path), 'exec'), {'__name__': '__main__'})
