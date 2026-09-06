#!/usr/bin/env python3
"""P12 pattern D driver: phase1 -> restart -> phase3.

Usage: python p12-d-driver.py <port> <container> <volume> <log>
"""
import os
import subprocess
import sys
import time

port = sys.argv[1]
container = sys.argv[2]
volume = sys.argv[3]
log = sys.argv[4]

def sh(cmd, timeout=180, env=None):
    print(f"[D] $ {cmd}", flush=True)
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=env)
    return r.returncode, r.stdout, r.stderr

def log_line(s):
    with open(log, "a", encoding="utf-8") as f:
        f.write(s + "\n")
    print(s, flush=True)

def restart_container(wipe_volume=True):
    log_line(f"[D-driver] === restart {container} on port {port} vol={volume} wipe={wipe_volume} ===")
    sh(f"docker rm -f {container}", timeout=30)
    time.sleep(2)
    if wipe_volume:
        sh(f"docker volume rm {volume}", timeout=30)
        time.sleep(2)
    if wipe_volume:
        sh(f"bash /c/src/hashsucker/scripts/restart-p12d.sh {container} {port} {volume}", timeout=60)
    else:
        sh(f"bash /c/src/hashsucker/scripts/restart-p12d-keep.sh {container} {port} {volume}", timeout=60)
    time.sleep(5)  # extra wait for boot
    # Probe with patience
    for i in range(20):
        rc, out, err = sh(f"curl -s -m 3 http://127.0.0.1:{port}/metrics > /dev/null && echo OK || echo FAIL", timeout=10)
        if "OK" in out:
            log_line(f"[D-driver] container back up on {port} (probe attempt {i+1})")
            return
        time.sleep(1)
    log_line(f"[D-driver] WARNING: container did not come up on {port}")

def run_phase1():
    log_line(f"[D-driver] === PHASE 1: pre-restart 0..7 on {port} ===")
    env = os.environ.copy()
    env["DP_URL"] = f"http://127.0.0.1:{port}"
    env["LABEL"] = "p12-D"
    cmd = "cd C:/src/hashsucker && node hy4-data-plane/bench/p12-soak-D-phase1.mjs"
    rc, out, err = sh(cmd, timeout=120, env=env)
    with open(log, "a", encoding="utf-8") as f:
        f.write(out)
        if err:
            f.write(err)
    log_line(f"[D-driver] phase1 rc={rc}")

def run_phase3():
    log_line(f"[D-driver] === PHASE 3: post-restart on {port} ===")
    env = os.environ.copy()
    env["DP_URL"] = f"http://127.0.0.1:{port}"
    env["LABEL"] = "p12-D"
    cmd = "cd C:/src/hashsucker && node hy4-data-plane/bench/p12-soak-D-phase3.mjs"
    rc, out, err = sh(cmd, timeout=120, env=env)
    with open(log, "a", encoding="utf-8") as f:
        f.write(out)
        if err:
            f.write(err)
    log_line(f"[D-driver] phase3 rc={rc}")

with open(log, "w", encoding="utf-8") as f:
    f.write("")

restart_container(wipe_volume=True)
run_phase1()
restart_container(wipe_volume=False)
run_phase3()
log_line(f"[D-driver] === done ===")
