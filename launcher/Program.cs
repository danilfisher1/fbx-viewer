using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

// 3D-просмотр: локальный сервер для вшитого вьювера + файлы моделей из папок рядом с exe.
// Слушает только localhost — с других компьютеров недоступен. Закрыли окно — сервер остановился.

Console.OutputEncoding = Encoding.UTF8;
Console.Title = "3D-просмотр";

var exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
var projectName = new DirectoryInfo(exeDir).Name;
var site = LoadSite();
var files = FindModelFiles(exeDir);
var allowed = new HashSet<string>(files.Select(f => f.Rel), StringComparer.OrdinalIgnoreCase);

var port = FreePort();
var origin = $"http://localhost:{port}";
var listener = new HttpListener();
listener.Prefixes.Add(origin + "/");
listener.Start();

Console.WriteLine($"3D-просмотр — {projectName}");
if (files.Count > 0)
{
    long total = files.Sum(f => f.Size);
    Console.WriteLine($"Найдено файлов: {files.Count} ({total / 1024.0 / 1024.0:0.0} МБ)");
}
else
{
    Console.WriteLine("Рядом с программой нет папок «Высокополигональная» / «Низкополигональная» —");
    Console.WriteLine("в браузере откроется экран выбора папки проекта.");
}
Console.WriteLine();
Console.WriteLine($"Открываю браузер: {origin}");
Console.WriteLine("Не закрывайте это окно, пока смотрите модель.");

// --no-browser: только сервер (для проверки сборки), браузер не открывается.
if (!args.Contains("--no-browser"))
{
    try { Process.Start(new ProcessStartInfo(origin) { UseShellExecute = true }); }
    catch { Console.WriteLine("Не удалось открыть браузер — откройте адрес выше вручную."); }
}

while (true)
{
    HttpListenerContext ctx;
    try { ctx = await listener.GetContextAsync(); }
    catch (HttpListenerException) { break; }
    _ = Task.Run(() => Handle(ctx));
}

async Task Handle(HttpListenerContext ctx)
{
    var req = ctx.Request;
    var res = ctx.Response;
    try
    {
        // Защита от DNS-rebinding: отвечаем только на свой адрес.
        if (!string.Equals(req.Url?.Authority, $"localhost:{port}", StringComparison.OrdinalIgnoreCase))
        {
            res.StatusCode = 403;
            return;
        }
        var path = req.Url!.AbsolutePath;
        if (path == "/__local/info")
        {
            await WriteBytes(res, InfoJson(), "application/json; charset=utf-8", noCache: true);
            return;
        }
        if (path == "/__local/file")
        {
            var rel = (req.QueryString["path"] ?? "").Replace('\\', '/');
            if (!allowed.Contains(rel)) { res.StatusCode = 404; return; }
            var full = Path.GetFullPath(Path.Combine(exeDir, rel));
            if (!full.StartsWith(Path.GetFullPath(exeDir), StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                res.StatusCode = 404;
                return;
            }
            await using var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, useAsync: true);
            res.ContentType = "application/octet-stream";
            res.ContentLength64 = fs.Length;
            await fs.CopyToAsync(res.OutputStream, 1 << 20);
            return;
        }
        var key = path == "/" ? "index.html" : Uri.UnescapeDataString(path.TrimStart('/'));
        if (site.TryGetValue(key, out var bytes))
        {
            await WriteBytes(res, bytes, ContentType(key), noCache: key == "index.html");
            return;
        }
        res.StatusCode = 404;
    }
    catch
    {
        // Браузер закрыл вкладку посреди передачи — это нормально.
    }
    finally
    {
        try { res.Close(); } catch { }
    }
}

static async Task WriteBytes(HttpListenerResponse res, byte[] bytes, string type, bool noCache)
{
    res.ContentType = type;
    res.ContentLength64 = bytes.Length;
    if (noCache) res.Headers["Cache-Control"] = "no-cache";
    await res.OutputStream.WriteAsync(bytes);
}

byte[] InfoJson()
{
    using var ms = new MemoryStream();
    using (var w = new Utf8JsonWriter(ms))
    {
        w.WriteStartObject();
        w.WriteString("name", projectName);
        w.WriteStartArray("files");
        foreach (var f in files)
        {
            w.WriteStartObject();
            w.WriteString("path", f.Rel);
            w.WriteNumber("size", f.Size);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }
    return ms.ToArray();
}

static Dictionary<string, byte[]> LoadSite()
{
    var dict = new Dictionary<string, byte[]>(StringComparer.Ordinal);
    using var stream = typeof(ModelFile).Assembly.GetManifestResourceStream("site.zip")
        ?? throw new InvalidOperationException("В программу не вшит вьювер (site.zip)");
    using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
    foreach (var e in zip.Entries)
    {
        if (e.FullName.EndsWith('/')) continue;
        using var s = e.Open();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        dict[e.FullName.Replace('\\', '/')] = ms.ToArray();
    }
    return dict;
}

/// Папки ВПМ / НПМ рядом с exe (по слову «полигональн» в имени — как в выгрузке АГР).
/// Если их нет, но рядом лежат архивы / FBX — берём их (до 3 уровней вложенности).
static List<ModelFile> FindModelFiles(string root)
{
    var exts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".zip", ".fbx", ".geojson", ".json", ".png", ".jpg", ".jpeg", ".tga", ".webp" };
    var result = new List<ModelFile>();

    void Walk(string dir, int depth)
    {
        if (depth > 6) return;
        IEnumerable<string> entries;
        try { entries = Directory.EnumerateFiles(dir); } catch { return; }
        foreach (var f in entries)
        {
            if (!exts.Contains(Path.GetExtension(f))) continue;
            var rel = Path.GetRelativePath(root, f).Replace('\\', '/');
            result.Add(new ModelFile(rel, new FileInfo(f).Length));
        }
        try { foreach (var d in Directory.EnumerateDirectories(dir)) Walk(d, depth + 1); } catch { }
    }

    var branchDirs = Directory.EnumerateDirectories(root)
        .Where(d => Path.GetFileName(d).Contains("полигональн", StringComparison.OrdinalIgnoreCase))
        .ToList();
    if (branchDirs.Count > 0)
    {
        foreach (var d in branchDirs) Walk(d, 1);
    }
    else
    {
        Walk(root, 4); // только до 3 уровней вниз — не обходим весь диск, если exe лежит не там
    }
    if (!result.Any(f => f.Rel.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) || f.Rel.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)))
        result.Clear();
    return result;
}

static int FreePort()
{
    var l = new TcpListener(IPAddress.Loopback, 0);
    l.Start();
    var p = ((IPEndPoint)l.LocalEndpoint).Port;
    l.Stop();
    return p;
}

static string ContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
{
    ".html" => "text/html; charset=utf-8",
    ".js" => "text/javascript; charset=utf-8",
    ".css" => "text/css; charset=utf-8",
    ".svg" => "image/svg+xml",
    ".png" => "image/png",
    ".jpg" or ".jpeg" => "image/jpeg",
    ".json" => "application/json",
    ".wasm" => "application/wasm",
    _ => "application/octet-stream",
};

record ModelFile(string Rel, long Size);
