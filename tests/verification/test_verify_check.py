import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('verify_check', Path(__file__).resolve().parents[2] / 'scripts/verify-check.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GateTests(unittest.TestCase):
    def test_false_success_is_rejected(self):
        for check in module.CHECKS:
            with self.subTest(check=check):
                self.assertTrue(module.validate(check, 0, 'nothing executed'))

    def test_backend_exact_count_and_skips(self):
        log = 'Ran 59 tests\nOK\nAll checks passed!\nNo changes detected\n'
        self.assertEqual(module.validate('backend', 0, log), [])
        for changed in (log.replace('59', '58'), log + 'OK (skipped=1)', log + 'SKIPPED', log + '1 did not run'):
            self.assertTrue(module.validate('backend', 0, changed))
        self.assertTrue(module.validate('backend', 1, log))

    def test_frontend_exact_count(self):
        log = 'Tests 78 passed (78)\neslint . --max-warnings 0\ntsc --noEmit\nbuilt in 1s'
        self.assertEqual(module.validate('frontend', 0, log), [])
        for changed in (log.replace('78 passed', '77 passed'), log + '\n1 skipped', log + '\n1 flaky'):
            self.assertTrue(module.validate('frontend', 0, changed))

    def test_e2e_requires_complete_json(self):
        stats = {'expected': 44, 'skipped': 0, 'unexpected': 0, 'flaky': 0}
        log = '44 passed (3m)'
        self.assertEqual(module.validate('e2e', 0, log, stats), [])
        self.assertTrue(module.validate('e2e', 0, log))
        self.assertTrue(module.validate('e2e', 0, '43 passed (3m)', stats))
        for key in stats:
            changed = dict(stats)
            changed[key] += 1
            self.assertTrue(module.validate('e2e', 0, log, changed))
        self.assertTrue(module.validate('e2e', 0, log, {}))


if __name__ == '__main__':
    unittest.main()
