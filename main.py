#!/usr/bin/env python

import logging
import os
import re
import shutil
import ssl
import typing
import urllib.parse
import zipfile

import aiohttp
import decky  # type: ignore
from settings import SettingsManager  # type: ignore

# Setup environment variables
settingsDir = decky.DECKY_PLUGIN_SETTINGS_DIR
loggingDir = decky.DECKY_PLUGIN_LOG_DIR

# Setup backend logger
logger = decky.logger
logger.setLevel(logging.DEBUG)
logger.info("[backend] Settings path: {}".format(settingsDir))

settings = SettingsManager(name="settings", settings_directory=settingsDir)
settings.read()

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 CheatDeck2-Decky-Plugin"
)

# flingtrainer.com's download links (https://flingtrainer.com/downloads/<token>,,)
# redirect to the real file, but the redirect target 403s for any request that
# doesn't carry a same-site Referer - confirmed by reproducing the exact 403
# from the logs with a bare fetch() and watching it succeed again once a
# Referer header is added back in. A real browser sends this automatically
# when the link is clicked from a page on the site, so it's set explicitly
# here since aiohttp never sends one on its own.
REFERER = "https://flingtrainer.com/"

# Only ever fetch from / download from this host. search_trainers never takes
# a user-supplied URL, but get_trainer_downloads and download_trainer do (a
# trainer page URL from a prior search, and a download URL from that page),
# so this guards against ever being pointed at an untrusted host.
ALLOWED_HOSTS = ("flingtrainer.com",)

# decky-loader's frozen backend does not reliably resolve the system's CA
# trust store for a plugin's own outbound HTTPS connections (confirmed on
# real hardware: aiohttp raised "SSLCertVerificationError: unable to get
# local issuer certificate" even though the host's certificate is fine) - so
# a CA bundle is shipped alongside main.py and used explicitly instead of
# relying on whatever default OpenSSL search paths the frozen build has.
_CACERT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cacert.pem")


def _make_ssl_context() -> typing.Union[ssl.SSLContext, bool]:
    # NOTE: aiohttp treats an explicit `ssl=None` as "skip verification", not
    # "use the default trust store" - only the literal `True` means that. So
    # the fallback here must be `True`, never `None`, or a failure to load
    # the bundled CA file would silently disable certificate verification
    # instead of just falling back to the (currently broken, but at least
    # not insecure) system default.
    try:
        return ssl.create_default_context(cafile=_CACERT_PATH)
    except (OSError, ssl.SSLError) as error:
        logger.error("[backend] Could not load bundled CA bundle ({}): {}".format(_CACERT_PATH, error))
        return True


# Key under which a manifest of already-downloaded trainers is stored via
# SettingsManager, so the Trainers tab can show a checkmark next to a
# download option the user already has - keyed by the download's own URL
# (unique per specific trainer version), not by game, since a user may have
# downloaded one version of a game's trainer but not another.
DOWNLOADED_TRAINERS_KEY = "DownloadedTrainersV1"

SIDECAR_WRAPPER_FILENAME = "sidecar-launch.sh"

# CheatDeck's "Sidecar Program" feature normally relies on Proton's own
# PROTON_REMOTE_DEBUG_CMD hook to launch a Windows helper program (a trainer
# or utility) inside the same Wine prefix as the game. Some Proton/Wine
# builds silently stop honoring that hook - see
# https://github.com/GloriousEggroll/proton-ge-custom/issues/664 - so this
# script is added as a launch-option prefix command alongside it (see
# domain/features.ts on the frontend): it gives Proton's own hook a moment to
# work, and if the sidecar still isn't running, launches it directly via the
# game's own Wine build before handing off to the game itself.
SIDECAR_WRAPPER_SCRIPT = """#!/usr/bin/env bash
set -u

if [ "${1:-}" = "--" ]; then
    shift
fi

# Is a Wine process already running our sidecar? Deliberately narrower than
# `pgrep -f "$proc_name"`: this whole script is itself invoked from a shell
# command line that embeds the sidecar's own path (Steam builds the launch
# command from PROTON_REMOTE_DEBUG_CMD/CHEATDECK_SIDECAR), so a plain
# full-command-line match would always "find" that invoking shell and never
# fall back to Wine. Instead, only look at actual Wine processes' command
# lines for the sidecar's filename.
sidecar_already_running() {
    local name="$1" pid comm cmdline
    for pid in /proc/[0-9]*; do
        pid="${pid#/proc/}"
        comm=$(cat "/proc/$pid/comm" 2>/dev/null) || continue
        case "$comm" in
            wine | wine64 | wine-preloader | wine64-preloader) ;;
            *) continue ;;
        esac
        cmdline=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || continue
        case "$cmdline" in
            *"$name"*) return 0 ;;
        esac
    done
    return 1
}

sidecar="${CHEATDECK_SIDECAR:-}"
if [ -n "$sidecar" ] && [ -f "$sidecar" ]; then
    (
        sleep 2
        proc_name=$(basename -- "$sidecar")
        if ! sidecar_already_running "$proc_name"; then
            tool_path="${STEAM_COMPAT_TOOL_PATHS%%:*}"
            wine_bin="$tool_path/files/bin/wine"
            prefix="${STEAM_COMPAT_DATA_PATH:-}/pfx"
            if [ -x "$wine_bin" ] && [ -n "${STEAM_COMPAT_DATA_PATH:-}" ]; then
                WINEPREFIX="$prefix" "$wine_bin" "$sidecar" >/dev/null 2>&1 &
            fi
        fi
    ) &
fi

exec "$@"
"""


class SetSettingOptions(typing.TypedDict):
    key: str
    value: typing.Any


class GetSettingOptions(typing.TypedDict):
    key: str
    defaults: typing.Any


class SearchTrainersOptions(typing.TypedDict):
    query: str


class GetTrainerDownloadsOptions(typing.TypedDict):
    url: str


class DownloadTrainerOptions(typing.TypedDict):
    url: str
    appid: int
    game_name: str
    label: str


class TrainerLink(typing.TypedDict):
    href: str
    text: str


# NOTE: decky-loader's backend runs as a frozen (PyInstaller) executable, and
# a plugin's main.py is exec'd inside that same process rather than a normal
# system Python - so only stdlib modules decky-loader's own code happens to
# import get bundled. `html.parser` and `urllib.request` are NOT among them
# (decky-loader does its own HTTP via `aiohttp`), so this file deliberately
# avoids both: link/entity extraction below is done with plain `re`, and
# fetching uses `aiohttp` (which decky-loader's frozen build does bundle).
# Do not reintroduce `html.parser`/`urllib.request` imports here - it will
# make the plugin fail to load on real hardware with
# "ModuleNotFoundError: No module named 'html.parser'" (or 'urllib.request'),
# even though both exist fine in a normal, non-frozen Python install.

_ENTITIES = {
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
    "nbsp": " ",
    "mdash": "—",
    "ndash": "–",
    "hellip": "…",
    "rsquo": "’",
    "lsquo": "‘",
    "rdquo": "”",
    "ldquo": "“",
}
_ENTITY_RE = re.compile(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);")
_LINK_RE = re.compile(
    r'<a\b[^>]*?\bhref\s*=\s*(["\'])(?P<href>.*?)\1[^>]*>(?P<body>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
# Matches only a search result's own title link
# (<h2 class="post-title"><a href="...">Name</a></h2>), which is the one
# piece of markup that's unique to an actual hit. Earlier code instead
# scanned a rough slice of the page between "search results" and the next
# sidebar heading, but flingtrainer.com's own <title> tag and RSS <link> also
# contain the words "search results" *before* the real results section does,
# so `str.find` locked onto that instead and the "slice" ended up covering
# the site's nav bar (whose "Trainers" category link matches "/trainer/" the
# same as a real hit) all the way through the actual results - and each
# result's own "N comments" link (also pointing at the trainer page, just
# with a #comments fragment) was indistinguishable from its title link too.
# Matching this specific heading avoids all of that, and doesn't collide with
# the "Popular Trainers" / "NEW TRAINER RELEASES" sidebar widgets, which use
# an unrelated "wpp-post-title" class from a different WordPress plugin.
_SEARCH_RESULT_RE = re.compile(
    r'<h2\s+class\s*=\s*(["\'])post-title\1\s*>\s*<a\b[^>]*?\bhref\s*=\s*(["\'])(?P<href>.*?)\2[^>]*>(?P<body>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")


def _unescape_entities(text: str) -> str:
    def replace(match: "re.Match[str]") -> str:
        entity = match.group(1)
        try:
            if entity.startswith("#x") or entity.startswith("#X"):
                return chr(int(entity[2:], 16))
            if entity.startswith("#"):
                return chr(int(entity[1:]))
        except ValueError:
            return match.group(0)
        return _ENTITIES.get(entity, match.group(0))

    return _ENTITY_RE.sub(replace, text)


def _is_allowed_url(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return any(host == allowed or host.endswith("." + allowed) for allowed in ALLOWED_HOSTS)


async def _fetch_text(url: str, timeout: float = 15) -> str:
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", "Referer": REFERER}
    client_timeout = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        # nosec - host allowlisted by caller
        async with session.get(url, headers=headers, ssl=_make_ssl_context()) as response:
            response.raise_for_status()
            raw = await response.read()
            charset = response.charset or "utf-8"
    return raw.decode(charset, errors="replace")


async def _fetch_bytes(url: str, timeout: float = 45) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Referer": REFERER}
    client_timeout = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        # nosec - host allowlisted by caller
        async with session.get(url, headers=headers, ssl=_make_ssl_context()) as response:
            response.raise_for_status()
            return await response.read()


def _extract_links(html_text: str) -> typing.List[TrainerLink]:
    links: typing.List[TrainerLink] = []
    for match in _LINK_RE.finditer(html_text):
        href = _unescape_entities(match.group("href").strip())
        if not href:
            continue
        text = _TAG_RE.sub(" ", match.group("body"))
        text = re.sub(r"\s+", " ", _unescape_entities(text)).strip()
        if text:
            links.append({"href": href, "text": text})
    return links


_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize_filename(name: str) -> str:
    name = _UNSAFE_FILENAME_RE.sub("_", name.strip())
    name = name.strip(" .")
    return name or "trainer"


def _clear_directory(path: str) -> None:
    if os.path.isdir(path):
        shutil.rmtree(path)
    os.makedirs(path, exist_ok=True)


def _find_trainer_executable(root: str) -> typing.Optional[str]:
    candidates = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for filename in filenames:
            if filename.lower().endswith(".exe"):
                candidates.append(os.path.join(dirpath, filename))
    if not candidates:
        return None
    named = [path for path in candidates if "trainer" in os.path.basename(path).lower()]
    pool = named or candidates
    pool.sort(key=os.path.getsize, reverse=True)
    return pool[0]


def _get_downloaded_trainers() -> typing.Dict[str, typing.Any]:
    manifest = settings.getSetting(DOWNLOADED_TRAINERS_KEY, {})
    if not isinstance(manifest, dict):
        return {}
    # A recorded download only counts if the file is still actually there -
    # the user may have deleted it manually, or wiped the Downloads folder -
    # so stale entries are dropped (and the pruned manifest re-saved) rather
    # than showing a checkmark for a trainer that's no longer on disk.
    pruned = {
        url: entry
        for url, entry in manifest.items()
        if isinstance(entry, dict) and isinstance(entry.get("path"), str) and os.path.exists(entry["path"])
    }
    if len(pruned) != len(manifest):
        settings.setSetting(DOWNLOADED_TRAINERS_KEY, pruned)
    return pruned


def _record_downloaded_trainer(url: str, path: str, appid: int, game_name: str, label: str) -> None:
    manifest = settings.getSetting(DOWNLOADED_TRAINERS_KEY, {})
    if not isinstance(manifest, dict):
        manifest = {}
    manifest[url] = {"path": path, "appid": appid, "game_name": game_name, "label": label}
    settings.setSetting(DOWNLOADED_TRAINERS_KEY, manifest)


def _write_sidecar_wrapper() -> None:
    try:
        os.makedirs(decky.DECKY_PLUGIN_RUNTIME_DIR, exist_ok=True)
        wrapper_path = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, SIDECAR_WRAPPER_FILENAME)
        with open(wrapper_path, "w") as wrapper_file:
            wrapper_file.write(SIDECAR_WRAPPER_SCRIPT)
        os.chmod(wrapper_path, 0o755)
        logger.info("[backend] Wrote sidecar wrapper to {}".format(wrapper_path))
    except OSError as error:
        logger.error("[backend] Failed to write sidecar wrapper: {}".format(error))


class Plugin:
    @classmethod
    async def _main(cls):
        logger.info("[backend] Loading CheatDeck 2!")
        _write_sidecar_wrapper()
        try:
            cacert_size = os.path.getsize(_CACERT_PATH)
        except OSError as error:
            cacert_size = "MISSING ({})".format(error)
        logger.info(
            "[backend] __file__={} CA bundle path={} size={}".format(
                os.path.abspath(__file__), _CACERT_PATH, cacert_size
            )
        )

    @classmethod
    async def _unload(cls):
        logger.info("[backend] Unloading CheatDeck 2!")

    @classmethod
    async def _uninstall(cls):
        logger.info("[backend] Uninstalling CheatDeck 2!")

    @classmethod
    async def read_settings(cls):
        logger.info("[backend] Reading settings")
        return settings.read()

    @classmethod
    async def commit_settings(cls):
        logger.info("[backend] Saving settings")
        return settings.commit()

    @classmethod
    async def get_setting(cls, data: GetSettingOptions):
        value = settings.getSetting(data["key"], data["defaults"])
        logger.info("[backend] Get {}: {}".format(data["key"], value))
        return value

    @classmethod
    async def set_setting(cls, data: SetSettingOptions):
        logger.info("[backend] Set {}: {}".format(data["key"], data["value"]))
        return settings.setSetting(data["key"], data["value"])

    @classmethod
    async def _migration(cls):
        if settings.getSetting("CustomOptionsV6", None) is not None:
            return

        logger.info("[backend] Initializing custom option presets")
        settings.setSetting("CustomOptionsV6", [
            {
                "id": "preset-lossless-scaling",
                "label": "LSFG-VK Frame Generation",
                "definition": {
                    "kind": "prefix",
                    "command": "~/lsfg",
                    "argv": [],
                },
            },
            {
                "id": "preset-framegen-patch",
                "label": "Enable OptiScaler",
                "definition": {
                    "kind": "prefix",
                    "command": "~/fgmod/fgmod",
                    "argv": [],
                },
            },
            {
                "id": "preset-framegen-unpatch",
                "label": "Disable OptiScaler",
                "definition": {
                    "kind": "prefix",
                    "command": "~/fgmod/fgmod-uninstaller.sh",
                    "argv": [],
                },
            },
        ])

    @classmethod
    async def get_env(cls, env: str):
        return getattr(decky, env)

    # --- FLiNG Trainer (https://flingtrainer.com) search & download ---
    #
    # Runs here on the backend rather than the frontend webview: it needs
    # real filesystem access to save and extract the archive, and Steam's
    # CEF webview does not allow arbitrary cross-origin fetch() calls the
    # way a normal backend HTTP request can. All three methods only ever
    # talk to flingtrainer.com (see ALLOWED_HOSTS / _is_allowed_url).

    @classmethod
    async def search_trainers(cls, data: SearchTrainersOptions):
        query = (data.get("query") or "").strip()
        if not query:
            return []

        url = "https://flingtrainer.com/?s=" + urllib.parse.quote_plus(query)
        try:
            html_text = await _fetch_text(url)
        except Exception as error:  # noqa: BLE001 - surfaced to the UI as "no results"
            logger.error("[backend] Trainer search failed: {}".format(error))
            return []

        seen: typing.Set[str] = set()
        results = []
        for match in _SEARCH_RESULT_RE.finditer(html_text):
            href = _unescape_entities(match.group("href").strip())
            if not href:
                continue
            absolute = urllib.parse.urljoin(url, href)
            if "/trainer/" not in absolute or absolute in seen or not _is_allowed_url(absolute):
                continue
            text = _TAG_RE.sub(" ", match.group("body"))
            text = re.sub(r"\s+", " ", _unescape_entities(text)).strip()
            if not text:
                continue
            seen.add(absolute)
            results.append({"title": text, "url": absolute})
            if len(results) >= 20:
                break
        return results

    @classmethod
    async def get_trainer_downloads(cls, data: GetTrainerDownloadsOptions):
        url = data.get("url") or ""
        if not _is_allowed_url(url):
            logger.error("[backend] Refusing to fetch untrusted trainer page: {}".format(url))
            return []

        try:
            html_text = await _fetch_text(url)
        except Exception as error:  # noqa: BLE001 - surfaced to the UI as "no results"
            logger.error("[backend] Fetching trainer page failed: {}".format(error))
            return []

        downloaded_urls = set(_get_downloaded_trainers().keys())

        seen: typing.Set[str] = set()
        downloads = []
        for link in _extract_links(html_text):
            if "download" not in link["href"].lower():
                continue
            absolute = urllib.parse.urljoin(url, link["href"])
            if absolute in seen or not _is_allowed_url(absolute):
                continue
            seen.add(absolute)
            downloads.append({
                "label": link["text"] or absolute,
                "url": absolute,
                "downloaded": absolute in downloaded_urls,
            })
        return downloads

    @classmethod
    async def download_trainer(cls, data: DownloadTrainerOptions):
        url = data.get("url") or ""
        appid = data.get("appid") or 0
        if not _is_allowed_url(url):
            logger.error("[backend] Refusing to download from untrusted host: {}".format(url))
            return {"ok": False, "error": "Refusing to download from an untrusted host."}

        try:
            payload = await _fetch_bytes(url)
        except Exception as error:  # noqa: BLE001 - surfaced to the UI
            logger.error("[backend] Trainer download failed: {}".format(error))
            return {"ok": False, "error": "Download failed: {}".format(error)}

        # Saved under the user's own Downloads folder (not decky's internal
        # plugin runtime dir) so the archive/trainer is visible to the user
        # the same way any other download is - see
        # https://github.com/SheffeyG/CheatDeck (user report: "downloaded a
        # trainer and when i went to download folder its not there").
        folder_name = _sanitize_filename(data.get("game_name") or str(appid))
        dest_dir = os.path.join(decky.DECKY_USER_HOME, "Downloads", "CheatDeck 2", folder_name)
        try:
            os.makedirs(dest_dir, exist_ok=True)
        except OSError as error:
            logger.error("[backend] Could not create destination directory: {}".format(error))
            return {"ok": False, "error": "Could not create the destination directory."}

        # Not every FLiNG download link points at a zip archive - some serve
        # the trainer .exe directly (confirmed on a real "Content-Type:
        # application/x-msdownload" response with no zip involved at all, per
        # user report: "the files are not zipped they are in fact an exe
        # file"). Detected from the actual bytes ("MZ" is the DOS/PE
        # executable header) rather than the URL, since the URL shape alone
        # doesn't reliably tell the two apart - and when it's a bare exe,
        # it's saved straight into Downloads with no extraction step at all.
        if payload[:2] == b"MZ":
            exe_name = _sanitize_filename(data.get("label") or folder_name)
            if not exe_name.lower().endswith(".exe"):
                exe_name += ".exe"
            exe_path = os.path.join(dest_dir, exe_name)
            try:
                with open(exe_path, "wb") as exe_file:
                    exe_file.write(payload)
            except OSError as error:
                logger.error("[backend] Could not save trainer executable: {}".format(error))
                return {"ok": False, "error": "Could not save the downloaded trainer."}
            logger.info("[backend] Trainer ready for appid {}: {}".format(appid, exe_path))
            _record_downloaded_trainer(url, exe_path, appid, data.get("game_name") or "", data.get("label") or "")
            return {"ok": True, "path": exe_path}

        archive_bytes = payload
        try:
            archive_path = os.path.join(dest_dir, "trainer.zip")
            with open(archive_path, "wb") as archive_file:
                archive_file.write(archive_bytes)
        except OSError as error:
            logger.error("[backend] Could not save trainer archive: {}".format(error))
            return {"ok": False, "error": "Could not save the downloaded archive."}

        extracted_dir = os.path.join(dest_dir, "extracted")
        try:
            _clear_directory(extracted_dir)
        except OSError as error:
            logger.error("[backend] Could not prepare extraction directory: {}".format(error))
            return {"ok": False, "error": "Could not prepare the extraction directory."}

        try:
            with zipfile.ZipFile(archive_path) as archive:
                try:
                    archive.extractall(extracted_dir)
                except RuntimeError:
                    # FLiNG occasionally ships password-protected archives; try a
                    # couple of commonly cited passwords before giving up.
                    extracted = False
                    for password in (b"flingtrainer.com", b"www.flingtrainer.com"):
                        try:
                            archive.extractall(extracted_dir, pwd=password)
                            extracted = True
                            break
                        except RuntimeError:
                            continue
                    if not extracted:
                        return {
                            "ok": False,
                            "error": (
                                "This trainer's archive is password-protected. "
                                "Download it manually and set it as the Sidecar Program instead."
                            ),
                        }
        except zipfile.BadZipFile:
            return {
                "ok": False,
                "error": "The downloaded file wasn't a valid archive; the site's download link may have changed.",
            }

        exe_path = _find_trainer_executable(extracted_dir)
        if not exe_path:
            return {"ok": False, "error": "Could not find a trainer executable in the downloaded archive."}

        logger.info("[backend] Trainer ready for appid {}: {}".format(appid, exe_path))
        _record_downloaded_trainer(url, exe_path, appid, data.get("game_name") or "", data.get("label") or "")
        return {"ok": True, "path": exe_path}
