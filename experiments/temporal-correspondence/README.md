# Temporal Correspondence Experiment

Isolated research. No production integration.

## Source inputs

Expected source media is available locally, for example under:

- `/mnt/hashsucker-vfs/...` for active VFS files
- `/bytes/:tfId` via the local HashSucker data plane for superseded TFs

Do not commit source media or generated PCM.

## Reproduction

1. Probe metadata:

```sh
python3 probe_metadata.py
```

2. Build synthetic controlled variants with ffmpeg from a source segment.

3. Compile the audio correlator:

```sh
gcc -O2 -o xcorr xcorr.c -lm
```

4. Extract mono 1000 Hz PCM:

```sh
ffmpeg -i input.mkv -vn -ac 1 -ar 1000 -f s16le output.pcm
```

5. Run global correlation:

```sh
./xcorr a.pcm b.pcm 90 1000
```

6. Run window matching:

```sh
python3 window_match.py A.mkv B.mkv 300 300
```

## Untracked outputs

The following are intentionally ignored:

- generated media (`*.mkv`, `*.mp4`)
- raw PCM (`*.pcm`)
- downloaded byte ranges (`*.bin`)
- generated corpus/window extracts (`corpus/`, `realcache/`)
- compiled binaries (`xcorr`)

Only scripts, source, metadata, manifests, and documentation are tracked.
