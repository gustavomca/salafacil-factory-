#!/usr/bin/env python3
"""Run a product check and reject missing counts, skipped tests or stale E2E reports."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
CHECKS = ('backend', 'frontend', 'e2e', 'operations', 'reproduce')


def validate(check, exit_code, log, e2e_stats=None):
    log = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', log)
    errors = []
    if exit_code != 0:
        errors.append('script exit code is not zero')
    if re.search(r'\b[1-9][0-9]* (?:skipped|flaky|did not run)\b|skipped=[1-9][0-9]*|\bSKIPPED\b', log):
        errors.append('tests skipped, flaky or not run')
    required = {
        'backend': [r'Ran 59 tests\b', r'^OK\s*$', r'All checks passed!', r'No changes detected'],
        'frontend': [r'Tests\s+78 passed\b', r'built in', r'eslint \. --max-warnings 0', r'tsc --noEmit'],
        'e2e': [r'\b44 passed \('],
        'operations': [re.escape('Operations checks passed: setup/migrations/seed/restart/restore/TLS/CSRF/Unix/proxy/isolation configurations verified.')],
        'reproduce': [re.escape('Clean checkout setup passed: README up builds images, migrations/seed complete, HTML/health/CSRF respond through published loopback.'), re.escape('Clean checkout fixtures verified.')],
    }
    if any(not re.search(pattern, log, re.M) for pattern in required[check]):
        errors.append('required success marker or exact test count is missing')
    if check == 'e2e' and (not isinstance(e2e_stats, dict) or
                          any(e2e_stats.get(key) != value for key, value in
                              {'expected': 44, 'skipped': 0, 'unexpected': 0, 'flaky': 0}.items())):
        errors.append('fresh E2E JSON must contain 44 expected and zero skipped/unexpected/flaky')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('check', choices=CHECKS)
    args = parser.parse_args()
    reports_dir = ROOT / '.factory/artifacts/e2e'
    existing = set(reports_dir.glob('*/report.json'))
    out = ROOT / '.factory/ci' / uuid.uuid4().hex
    out.mkdir(parents=True)
    log_path = out / 'output.log'
    with log_path.open('wb') as stream:
        result = subprocess.run(['bash', f'scripts/test-{args.check}.sh'], cwd=ROOT,
                                stdout=stream, stderr=subprocess.STDOUT, check=False)
    raw = log_path.read_bytes()
    log = raw.decode(errors='replace')
    sys.stdout.write(log)
    stats = None
    report_error = None
    if args.check == 'e2e':
        fresh = set(reports_dir.glob('*/report.json')) - existing
        if len(fresh) == 1:
            try:
                stats = json.loads(next(iter(fresh)).read_text())['stats']
            except (ValueError, KeyError, OSError):
                report_error = 'E2E report cannot be read'
        else:
            report_error = 'exactly one newly created E2E JSON report is required'
    errors = validate(args.check, result.returncode, log, stats)
    if report_error:
        errors.append(report_error)
    record = {'check': args.check, 'script_exit_code': result.returncode,
              'log_sha256': hashlib.sha256(raw).hexdigest(), 'e2e_stats': stats,
              'errors': errors, 'passed': not errors}
    (out / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
