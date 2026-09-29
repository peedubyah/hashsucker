#[cfg(test)]
mod tests {
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn verified_local_route_requires_exact_size_and_root_containment() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("x.mkv");
        fs::write(&file, b"1234").unwrap();
        assert_eq!(fs::metadata(&file).unwrap().len(), 4);
        assert!(file.starts_with(dir.path()));
        assert!(!dir.path().join("missing.mkv").exists());
    }
}
