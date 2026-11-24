//! Compress and extract on the SFTP server (the remote file manager's "Compress" and "Extract"): SFTP can't do either,
//! so the file manager runs `zip` / `unzip` / `tar` there over the same SSH connection. This module is only the pure
//! part: which tools exist, what an archive's name says it is, and the exact shell command for each job. Every name that
//! reaches a command is checked first and single-quoted, so a file name can never become a command.

/// Which archive tools the server has.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Tools {
    pub zip: bool,
    pub unzip: bool,
    pub tar: bool,
}

/// The script that tells which tools exist (run through `sh -c`, so the user's login shell doesn't matter).
pub const PROBE: &str = r#"for c in zip unzip tar; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done; true"#;

/// The tools named, one per line, in the probe's output.
pub fn parse_tools(output: &str) -> Tools {
    let has = |n: &str| output.lines().any(|l| l.trim() == n);
    Tools { zip: has("zip"), unzip: has("unzip"), tar: has("tar") }
}

/// What a new archive is made as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zip,
    TarGz,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s { "zip" => Some(Format::Zip), "tar.gz" => Some(Format::TarGz), _ => None }
    }
    /// The extension a new archive of this format ends with.
    pub fn ext(self) -> &'static str { match self { Format::Zip => ".zip", Format::TarGz => ".tar.gz" } }
}

/// What an existing archive is, by its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    Tar,
}

/// `Some` when the file name ends like an archive this module can extract.
pub fn kind_of(name: &str) -> Option<Kind> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".zip") { return Some(Kind::Zip); }
    const TAR: [&str; 7] = [".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz"];
    TAR.iter().any(|e| n.ends_with(e)).then_some(Kind::Tar)
}

/// A single path component that is safe to hand to a command: not empty, no slash or NUL / control character,
/// not `.` or `..`.
pub fn safe_name(n: &str) -> bool {
    !n.is_empty() && n != "." && n != ".." && !n.contains('/') && !n.chars().any(char::is_control)
}

/// `s` as one shell word: single quotes, with any quote inside it closed, escaped and reopened.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A name inside the current folder written so that a leading `-` is not read as an option.
fn here(name: &str) -> String { quote(&format!("./{name}")) }

/// The whole command (for `sh -c`) that builds `out` in `dir` from `names`. Links are kept as links, not followed.
pub fn compress_command(dir: &str, names: &[String], out: &str, fmt: Format) -> String {
    let items = names.iter().map(|n| here(n)).collect::<Vec<_>>().join(" ");
    match fmt {
        Format::Zip => format!("cd {} && zip -r -q -y {} {}", quote(dir), here(out), items),
        Format::TarGz => format!("cd {} && tar -czf {} {}", quote(dir), here(out), items),
    }
}

/// The whole command (for `sh -c`) that extracts `archive` into `dest` (made when missing). `overwrite`: replace files
/// that are already there; otherwise they are kept.
pub fn extract_command(archive: &str, dest: &str, kind: Kind, overwrite: bool) -> String {
    match kind {
        Kind::Zip => format!("mkdir -p {d} && unzip -q {flag} {a} -d {d}", d = quote(dest), a = quote(archive), flag = if overwrite { "-o" } else { "-n" }),
        Kind::Tar => format!("mkdir -p {d} && tar -x{k}f {a} -C {d}", d = quote(dest), a = quote(archive), k = if overwrite { "" } else { "k" }),
    }
}

/// `tar -k` exits with an error for every file it kept; those lines are not a failure.
pub fn only_kept_files(stderr: &str) -> bool {
    let mut any = false;
    for l in stderr.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if l.contains("Cannot open: File exists") || l.starts_with("tar: Exiting with failure status due to previous errors") { any = true; continue; }
        return false;
    }
    any
}

/// The folder a "Extract to folder" puts the files in: the archive's name without its archive extension.
pub fn stem(name: &str) -> String {
    let n = name.to_string();
    let lower = n.to_ascii_lowercase();
    for e in [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".tar", ".zip"] {
        if lower.ends_with(e) { return n[..n.len() - e.len()].to_string(); }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_output_is_read_line_by_line() {
        assert_eq!(parse_tools("zip\ntar\n"), Tools { zip: true, unzip: false, tar: true });
        assert_eq!(parse_tools(""), Tools::default());
        assert_eq!(parse_tools("unzipper\nzipx\n"), Tools::default(), "only exact tool names count");
    }

    #[test]
    fn archive_kinds_come_from_the_name() {
        assert_eq!(kind_of("a.ZIP"), Some(Kind::Zip));
        for n in ["a.tar", "a.tar.gz", "a.TGZ", "a.tar.bz2", "a.tbz2", "a.tar.xz", "a.txz"] { assert_eq!(kind_of(n), Some(Kind::Tar), "{n}"); }
        for n in ["a.gz", "a.7z", "a.rar", "zip", "a.zip.txt", ""] { assert_eq!(kind_of(n), None, "{n}"); }
    }

    #[test]
    fn stems_drop_the_archive_extension() {
        assert_eq!(stem("site.tar.gz"), "site");
        assert_eq!(stem("Backup.ZIP"), "Backup");
        assert_eq!(stem("x.tgz"), "x");
        assert_eq!(stem("notes.txt"), "notes.txt");
    }

    #[test]
    fn quoting_closes_and_reopens_single_quotes() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("a b;rm -rf /"), "'a b;rm -rf /'");
        assert_eq!(quote("$(id)`id`"), "'$(id)`id`'");
    }

    #[test]
    fn only_a_plain_name_is_accepted() {
        for ok in ["file.txt", "my file", "-dash", "it's", "ünï"] { assert!(safe_name(ok), "{ok}"); }
        for bad in ["", ".", "..", "a/b", "/abs", "tab\there", "nl\nx", "nul\0x"] { assert!(!safe_name(bad), "{bad:?}"); }
    }

    #[test]
    fn compress_commands_quote_every_name_and_never_start_one_with_a_dash() {
        let names = vec!["-rf".to_string(), "it's here".to_string()];
        let zip = compress_command("/home/a b", &names, "out.zip", Format::Zip);
        assert_eq!(zip, r"cd '/home/a b' && zip -r -q -y './out.zip' './-rf' './it'\''s here'");
        let tar = compress_command("/srv", &["x".to_string()], "x.tar.gz", Format::TarGz);
        assert_eq!(tar, "cd '/srv' && tar -czf './x.tar.gz' './x'");
    }

    #[test]
    fn extract_commands_keep_or_replace_and_quote_paths() {
        assert_eq!(extract_command("/h/a b.zip", "/h/a b", Kind::Zip, false), "mkdir -p '/h/a b' && unzip -q -n '/h/a b.zip' -d '/h/a b'");
        assert_eq!(extract_command("/h/a.zip", "/h", Kind::Zip, true), "mkdir -p '/h' && unzip -q -o '/h/a.zip' -d '/h'");
        assert_eq!(extract_command("/h/a.tar.gz", "/h/a", Kind::Tar, false), "mkdir -p '/h/a' && tar -xkf '/h/a.tar.gz' -C '/h/a'");
        assert_eq!(extract_command("/h/a.tgz", "/h/a", Kind::Tar, true), "mkdir -p '/h/a' && tar -xf '/h/a.tgz' -C '/h/a'");
    }

    #[test]
    fn tar_keep_mode_errors_only_count_when_every_line_is_about_kept_files() {
        assert!(only_kept_files("tar: a: Cannot open: File exists\ntar: Exiting with failure status due to previous errors\n"));
        assert!(!only_kept_files("tar: a: Cannot open: File exists\ntar: b: Cannot open: Permission denied\n"));
        assert!(!only_kept_files(""));
    }

    #[test]
    fn formats_parse_and_name_their_extension() {
        assert_eq!(Format::parse("zip"), Some(Format::Zip));
        assert_eq!(Format::parse("tar.gz"), Some(Format::TarGz));
        assert_eq!(Format::parse("rar"), None);
        assert_eq!((Format::Zip.ext(), Format::TarGz.ext()), (".zip", ".tar.gz"));
    }
}
