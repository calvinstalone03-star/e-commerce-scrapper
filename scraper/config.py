"""Runtime settings and plain-text target file loaders.

Settings come from the process environment, backed by a ``.env`` file at the
repository root (see ``.env.example``). Nothing else in the package should read
``os.environ`` directly — import :func:`get_settings` instead so tests can
monkeypatch one place.

Environment variables, all optional except ``DATABASE_URL``:

===================  ==================  =============================================
Env var              Field               Notes
===================  ==================  =============================================
``DATABASE_URL``     ``database_url``    postgresql://calvin@127.0.0.1:5432/ecom_scraper
``SHOPEE_USERNAME``  ``shopee_username`` None => bootstrap stays logged out
``SHOPEE_PASSWORD``  ``shopee_password`` None => bootstrap stays logged out
``HEADLESS``         ``headless``        default true; set false to watch the bootstrap
``MIN_DELAY``        ``min_delay``       default 2.0 seconds
``MAX_DELAY``        ``max_delay``       default 5.0 seconds
``COOKIES_PATH``     ``cookies_path``    default ./cookies.json (gitignored)
===================  ==================  =============================================
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = ["Settings", "get_settings", "load_keywords", "load_stores", "load_lines"]

DEFAULT_KEYWORDS_FILE = Path("config/keywords.txt")
DEFAULT_STORES_FILE = Path("config/stores.txt")
DEFAULT_COOKIES_PATH = Path("cookies.json")


class Settings(BaseSettings):
    """Process-wide configuration loaded from the environment / ``.env``.

    Construct via :func:`get_settings` rather than instantiating directly, so a
    single cached instance is shared by the CLI, the session, the client and the
    runner. Instantiating ``Settings()`` directly is still valid and is the
    supported way to build an isolated instance inside a test.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    database_url: str = Field(
        default="postgresql://calvin@127.0.0.1:5432/ecom_scraper",
        description=(
            "SQLAlchemy/libpq URL for Postgres. scraper.db normalises the driver "
            "prefix to psycopg 3, so a bare 'postgresql://' URL is fine here."
        ),
    )
    shopee_username: str | None = Field(
        default=None,
        description="Shopee login. When both username and password are set, "
        "ShopeeSession.bootstrap_cookies() may perform an authenticated bootstrap.",
    )
    shopee_password: str | None = Field(
        default=None, description="Shopee password. See shopee_username."
    )
    headless: bool = Field(
        default=True,
        description="Run the Playwright bootstrap browser headless. Set false to debug "
        "or to solve a challenge by hand.",
    )
    min_delay: float = Field(
        default=2.0, ge=0.0, description="Lower bound, seconds, of the randomized inter-request delay."
    )
    max_delay: float = Field(
        default=5.0, ge=0.0, description="Upper bound, seconds, of the randomized inter-request delay."
    )
    cookies_path: Path = Field(
        default=DEFAULT_COOKIES_PATH,
        description="Where ShopeeSession persists the harvested cookie jar. Gitignored.",
    )

    @field_validator("cookies_path", mode="before")
    @classmethod
    def _coerce_cookies_path(cls, value: object) -> object:
        """Accept a ``str`` from the environment and turn it into a :class:`Path`.

        Args:
            value: Raw value from env/`.env`/constructor.

        Returns:
            The value unchanged if already a Path, else a Path built from it.
        """
        raise NotImplementedError

    @model_validator(mode="after")
    def _check_delay_bounds(self) -> "Settings":
        """Reject a configuration where ``min_delay`` exceeds ``max_delay``.

        Returns:
            ``self`` when the bounds are coherent.

        Raises:
            ValueError: If ``min_delay > max_delay``.
        """
        raise NotImplementedError

    @property
    def has_credentials(self) -> bool:
        """Whether an authenticated bootstrap is possible.

        Returns:
            True only when both ``shopee_username`` and ``shopee_password`` are
            set and non-empty. The bootstrap stays logged out otherwise — that
            is the default and supported posture.
        """
        raise NotImplementedError


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide cached :class:`Settings`.

    Cached so that ``.env`` is parsed once per process. Tests that need a
    different configuration should either call ``get_settings.cache_clear()``
    after monkeypatching the environment, or build ``Settings(...)`` directly and
    inject it.

    Returns:
        The shared Settings instance.
    """
    raise NotImplementedError


def load_lines(path: str | Path) -> list[str]:
    """Read a plain-text target file into a clean list of lines.

    Shared implementation behind :func:`load_keywords` and :func:`load_stores`.
    Rules, in order:

    1. Read the file as UTF-8.
    2. Strip leading/trailing whitespace from every line.
    3. Drop empty lines.
    4. Drop lines whose first non-whitespace character is ``#``.
    5. Preserve the file's ordering and preserve duplicates (the caller decides
       whether repeats matter).

    Note that ``#`` only starts a comment at the beginning of a line — a ``#``
    inside a keyword is kept verbatim, since Indonesian listing titles and shop
    handles can legitimately contain one.

    Args:
        path: Path to the text file.

    Returns:
        Cleaned, ordered list of non-empty, non-comment lines.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
    """
    raise NotImplementedError


def load_keywords(path: str | Path = DEFAULT_KEYWORDS_FILE) -> list[str]:
    """Load search keywords for ``--mode keyword``.

    Thin wrapper over :func:`load_lines`; kept as its own name so the CLI and the
    runner read declaratively and so keyword-specific normalisation (e.g. case
    folding) can be added later without touching call sites.

    Args:
        path: Keywords file. Defaults to ``config/keywords.txt``.

    Returns:
        Ordered list of keywords, blanks and ``#`` comments removed.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
    """
    raise NotImplementedError


def load_stores(path: str | Path = DEFAULT_STORES_FILE) -> list[str]:
    """Load shop usernames for ``--mode store``.

    Thin wrapper over :func:`load_lines`. Entries are the URL slug only — the
    loader must tolerate (and strip) a full ``https://shopee.co.id/<username>``
    URL or a leading ``@`` so a user can paste either form.

    Args:
        path: Stores file. Defaults to ``config/stores.txt``.

    Returns:
        Ordered list of bare shop usernames.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
    """
    raise NotImplementedError
