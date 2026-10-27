type SourceContext = {
  readonly config: Readonly<{ useCookies?: boolean; cookiesBrowser?: string }>;
  runTool(
    id: string,
    args: string[],
    options?: { onStdoutLine?: (line: string) => void },
  ): Promise<{ stdout: string; stderr: string }>;
  outputPath(fileName: string): string;
  reportProgress(progress: { percent?: number }): void;
};

type YtDlpInfo = {
  title?: string;
  artist?: string;
  duration?: number;
  webpage_url?: string;
};

const infoTemplate =
  '{"title":%(title)j,"artist":%(artist,uploader,channel|)j,"duration":%(duration|0)j,"webpage_url":%(webpage_url|)j}';

type PluginItem = {
  id: string;
  title: string;
  artist?: string | null;
  durationMs?: number | null;
  sourceUrl?: string | null;
  fileName: string;
};

const qualities = [
  { id: "0", label: "Best", format: "MP3 V0" },
  { id: "5", label: "Balanced", format: "MP3 V5" },
  { id: "9", label: "Compact", format: "MP3 V9" },
];

function browserCookieArgs(context: SourceContext): string[] {
  if (context.config.useCookies !== true) return [];
  const browser = context.config.cookiesBrowser?.trim();
  if (!browser || browser.length > 4096 || /[\u0000-\u001f\u007f]/.test(browser))
    throw new Error("Enter a browser name for browser cookies.");
  return ["--cookies-from-browser", browser];
}

function validateLink(input: string): string {
  if (input.length > 512) throw new Error("This link is too long.");
  const match = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(input);
  if (!match || match[1]!.includes("@") || /[\u0000-\u0020\\]/.test(input))
    throw new Error("Paste a valid HTTP or HTTPS link.");
  return input;
}

async function readInfo(context: SourceContext, input: string): Promise<YtDlpInfo> {
  const url = validateLink(input);
  const result = await context.runTool("yt-dlp", [
    "--ignore-config",
    ...browserCookieArgs(context),
    "--skip-download",
    "--quiet",
    "--no-progress",
    "--no-warnings",
    "--no-playlist",
    "--playlist-items",
    "1",
    "--no-call-home",
    "--print",
    infoTemplate,
    "--",
    url,
  ]);
  let info: YtDlpInfo;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid metadata object");
    }
    info = parsed as YtDlpInfo;
  } catch {
    throw new Error("yt-dlp returned invalid metadata for this link.");
  }
  if (typeof info.title !== "string" || !info.title.trim())
    throw new Error("yt-dlp did not find a playable item at this link.");
  return info;
}

function safeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "audio";
}

function sourceItem(input: string, info: YtDlpInfo): PluginItem {
  const artist = info.artist?.trim();
  return {
    id: input,
    title: info.title ?? "Audio",
    artist: artist || null,
    durationMs:
      typeof info.duration === "number" && Number.isFinite(info.duration)
        ? Math.max(0, Math.round(info.duration * 1000))
        : null,
    sourceUrl: info.webpage_url ?? input,
    fileName: `${safeTitle(info.title ?? "audio")}.mp3`,
  };
}

export default {
  async lookup(context: SourceContext, input: string) {
    const url = validateLink(input);
    return sourceItem(url, await readInfo(context, url));
  },

  async details(context: SourceContext, input: string) {
    const url = validateLink(input);
    const info = await readInfo(context, url);
    return {
      item: sourceItem(url, info),
      description:
        typeof info.duration === "number" && Number.isFinite(info.duration)
          ? `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration) % 60).padStart(2, "0")}`
          : undefined,
      qualities,
    };
  },

  async download(context: SourceContext, request: { id: string; quality?: string | null }) {
    const url = validateLink(request.id);
    const quality = qualities.find((choice) => choice.id === request.quality) ?? qualities[0]!;
    const info = await readInfo(context, url);
    const item = sourceItem(url, info);
    const output = context.outputPath("download.mp3");
    await context.runTool(
      "yt-dlp",
      [
        "--ignore-config",
        ...browserCookieArgs(context),
        "--no-playlist",
        "--newline",
        "--no-warnings",
        "--no-call-home",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        quality.id,
        "--output",
        output,
        "--",
        url,
      ],
      {
        onStdoutLine(line) {
          const match = /(?:^|\s)(\d{1,3}(?:\.\d+)?)%/.exec(line);
          if (match) context.reportProgress({ percent: Math.min(100, Number(match[1])) });
        },
      },
    );
    return {
      file: item,
      output,
    };
  },
};
