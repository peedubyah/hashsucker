import subprocess, os, sys

def extract(path, t, dur, out):
    subprocess.run(["ffmpeg","-y","-hide_banner","-loglevel","error","-ss",str(t),"-t",str(dur),"-i",path,"-vn","-ac","1","-ar","1000","-f","s16le",out], check=True)

def xcorr(a,b):
    r=subprocess.run(["./xcorr",a,b,"0","1000"],capture_output=True,text=True)
    corr=None
    for line in r.stdout.splitlines():
        if line.startswith("best_lag_sec="):
            corr=float(line.split()[1].split("=")[1])
    return corr

def run(A,B,durA,durB,win=10,step=30):
    # extract A windows
    awins=[]
    t=0
    while t+win <= durA:
        p=f"/tmp/aw_{t}.pcm"
        extract(A,t,win,p)
        awins.append((t,p))
        t+=step
    # extract B windows
    bwins=[]
    t=0
    while t+win <= durB:
        p=f"/tmp/bw_{t}.pcm"
        extract(B,t,win,p)
        bwins.append((t,p))
        t+=step
    results=[]
    for at,ap in awins:
        best=None
        for bt,bp in bwins:
            c=xcorr(ap,bp)
            if c is None: continue
            if best is None or c>best[1]:
                best=(bt,c)
        results.append((at,best[0],best[1]))
    # coverage
    thr=0.75
    good=[r for r in results if r[2]>=thr]
    print(f"A={A} B={B}")
    print(f"windows={len(results)} good={len(good)} coverage={len(good)/len(results):.2f}")
    for at,bt,c in results:
        print(f"  A@{at:4d}s -> B@{bt:4d}s corr={c: .3f} {'GOOD' if c>=thr else ''}")
    # lag deltas between consecutive good windows
    if len(good)>=2:
        deltas=[(good[i+1][0]-good[i][0], good[i+1][1]-good[i][1]) for i in range(len(good)-1)]
        print("  consecutive good window time deltas (A_delta, B_delta):", deltas)
    print()

if __name__=="__main__":
    # args: A B durA durB
    run(sys.argv[1],sys.argv[2],float(sys.argv[3]),float(sys.argv[4]))
