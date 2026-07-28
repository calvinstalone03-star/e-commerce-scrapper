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

from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = [
    "Settings",
    "get_settings",
    "load_keywords",
    "load_stores",
    "load_lines",
    "dedupe",
    "normalise_store_entry",
    "DEFAULT_DATABASE_URL",
    "DEFAULT_KEYWORDS_FILE",
    "DEFAULT_STORES_FILE",
    "DEFAULT_COOKIES_PATH",
]

DEFAULT_KEYWORDS_FILE = Path("config/keywords.txt")
DEFAULT_STORES_FILE = Path("config/stores.txt")
DEFAULT_COOKIES_PATH = Path("cookies.json")

#: Default Postgres URL. Kept as a module constant so tests and the CLI can refer
#: to it without instantiating :class:`Settings`.
DEFAULT_DATABASE_URL = "postgresql://calvin@127.0.0.1:5432/ecom_scraper"


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
        default=DEFAULT_DATABASE_URL,
        # repr=False: the URL embeds the database password. runner._record_failure
        # stores repr(exc) for arbitrary exceptions into scrape_runs.error, so a
        # single future `log.debug("settings=%s", settings)` would put the
        # password on stderr and, via an exception, into the database. Keeping it
        # out of __repr__ costs nothing — nothing formats a Settings today.
        repr=False,
        description=(
            "SQLAlchemy/libpq URL for Postgres. scraper.db normalises the driver "
            "prefix to psycopg 3, so a bare 'postgresql://' URL is fine here. "
            "Excluded from repr() because it embeds a password."
        ),
    )
    shopee_username: str | None = Field(
        default=None,
        description="Shopee login. When both username and password are set, "
        "ShopeeSession.bootstrap_cookies() may perform an authenticated bootstrap.",
    )
    shopee_password: str | None = Field(
        default=None,
        # repr=False for the same reason as database_url above. Kept a plain str
        # rather than SecretStr so session._attempt_login needs no unwrapping
        # and cannot grow a `.get_secret_value()` that leaks it back into a log.
        repr=False,
        description="Shopee password. See shopee_username. Excluded from repr().",
    )
    shopee_affiliate_app_id: str | None = Field(
        default=None,
        description="App ID from the Shopee Affiliate dashboard's Open API section. "
        "When this and the secret are both set, the affiliate adapter is preferred "
        "over web scraping for Shopee — it is the supported route to keyword search, "
        "which the web endpoint refuses.",
    )
    shopee_affiliate_app_secret: str | None = Field(
        default=None,
        # repr=False for the same reason as database_url: this is signing
        # material, and runner._record_failure persists repr(exc) into
        # scrape_runs.error.
        repr=False,
        description="App Secret from the Shopee Affiliate dashboard. Signing input "
        "only, never transmitted. Excluded from repr().",
    )
    shopee_affiliate_region: str = Field(
        default="id",
        description="Region key selecting the affiliate GraphQL endpoint "
        "(id, vn, br, th, my, ph, sg, tw).",
    )
    snapshot_dedupe_hours: float = Field(
        default=24.0,
        ge=0.0,
        description="Skip a price snapshot that repeats the previous one verbatim "
        "when the previous one is younger than this. Scraping the same page twice "
        "otherwise writes two identical rows, which are noise rather than history. "
        "Past this age an unchanged observation is written anyway, because "
        "'still this price a week later' is a real fact. Set 0 to always insert.",
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
        description="Where ShopeeSession persists the harvested cookie jar. Always "
        "written 0600. .gitignore covers the default name and anything matching "
        "*cookies*.json — point this somewhere else and it is on you to add that "
        "path to .gitignore too.",
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
        if value is None:
            return DEFAULT_COOKIES_PATH
        if isinstance(value, Path):
            return value
        if isinstance(value, str):
            text = value.strip()
            return DEFAULT_COOKIES_PATH if not text else Path(text).expanduser()
        return value

    @model_validator(mode="after")
    def _check_delay_bounds(self) -> "Settings":
        """Reject a configuration where ``min_delay`` exceeds ``max_delay``.

        Returns:
            ``self`` when the bounds are coherent.

        Raises:
            ValueError: If ``min_delay > max_delay``.
        """
        if self.min_delay > self.max_delay:
            raise ValueError(
                f"MIN_DELAY ({self.min_delay}) must not exceed MAX_DELAY ({self.max_delay})"
            )
        return self

    @property
    def has_credentials(self) -> bool:
        """Whether an authenticated bootstrap is possible.

        Returns:
            True only when both ``shopee_username`` and ``shopee_password`` are
            set and non-empty. The bootstrap stays logged out otherwise — that
            is the default and supported posture.
        """
        return bool(
            self.shopee_username
            and self.shopee_username.strip()
            and self.shopee_password
            and self.shopee_password.strip()
        )

    @property
    def has_affiliate_credentials(self) -> bool:
        """Whether the Shopee Affiliate Open API can be used.

        Returns:
            True only when both the App ID and App Secret are set and non-empty.
            When True, ``scraper.adapters.get_adapter`` builds the affiliate
            adapter for Shopee instead of the web-scraping one, because the web
            path cannot reach keyword search at all.
        """
        return bool(
            self.shopee_affiliate_app_id
            and self.shopee_affiliate_app_id.strip()
            and self.shopee_affiliate_app_secret
            and self.shopee_affiliate_app_secret.strip()
        )


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
    return Settings()


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
    file_path = Path(path).expanduser()
    if not file_path.is_file():
        raise FileNotFoundError(f"target file not found: {file_path}")

    lines: list[str] = []
    for raw in file_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return lines


def dedupe(values: Iterable[str]) -> list[str]:
    """Drop repeats from ``values`` while preserving first-seen order.

    Comparison is exact (case- and whitespace-sensitive); callers are expected to
    have normalised beforehand. Used by :func:`load_keywords`,
    :func:`load_stores` and ``runner.resolve_targets`` so one invocation never
    scrapes the same target twice.

    Args:
        values: Iterable of already-cleaned strings.

    Returns:
        A new list without duplicates, in first-seen order.
    """
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def normalise_store_entry(entry: str) -> str:
    """Reduce one ``config/stores.txt`` line to a bare shop username.

    Tolerates the three forms a human is likely to paste:
    ``erigostore``, ``@erigostore`` and
    ``https://shopee.co.id/erigostore?foo=bar#frag``.

    Args:
        entry: One raw (already whitespace-stripped) line.

    Returns:
        The bare slug. Returns an empty string when nothing survives, which the
        caller drops.
    """
    text = entry.strip()
    if "://" in text:
        text = urlsplit(text).path
    text = text.split("?", 1)[0].split("#", 1)[0]
    text = text.strip().strip("/")
    if "/" in text:
        text = text.rsplit("/", 1)[-1]
    return text.lstrip("@").strip()


def load_keywords(path: str | Path = DEFAULT_KEYWORDS_FILE) -> list[str]:
    """Load search keywords for ``--mode keyword``.

    Thin wrapper over :func:`load_lines`; kept as its own name so the CLI and the
    runner read declaratively and so keyword-specific normalisation (e.g. case
    folding) can be added later without touching call sites.

    Args:
        path: Keywords file. Defaults to ``config/keywords.txt``.

    Returns:
        Ordered list of keywords, blanks and ``#`` comments removed, de-duplicated
        while preserving first-seen order.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
    """
    return dedupe(load_lines(path))


def load_stores(path: str | Path = DEFAULT_STORES_FILE) -> list[str]:
    """Load shop usernames for ``--mode store``.

    Thin wrapper over :func:`load_lines`. Entries are the URL slug only — the
    loader must tolerate (and strip) a full ``https://shopee.co.id/<username>``
    URL or a leading ``@`` so a user can paste either form.

    Args:
        path: Stores file. Defaults to ``config/stores.txt``.

    Returns:
        Ordered list of bare shop usernames, de-duplicated while preserving
        first-seen order.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
    """
    normalised = (normalise_store_entry(line) for line in load_lines(path))
    return dedupe(entry for entry in normalised if entry)
