from django.test.runner import DiscoverRunner


class NonEmptyDiscoverRunner(DiscoverRunner):
    """A discovery typo must fail CI instead of claiming that zero tests passed."""

    def run_suite(self, suite, **kwargs):
        if suite.countTestCases() == 0:
            raise RuntimeError(
                "Nenhum teste encontrado. Execute a partir de backend: manage.py test tests"
            )
        return super().run_suite(suite, **kwargs)
