#!/usr/bin/env python3
import json, subprocess, os, time

ROOT="/mnt/hashsucker-vfs"
files=[]
for dp,_,fs in os.walk(ROOT):
    for f in fs:
        if f.lower().endswith((".mkv",".mp4",".avi",".mov",".m4v")):
            files.append(os.path.join(dp,f))
files=sorted(files)

OUT="/home/patrick/src/hashsucker/experiments/temporal-correspondence/metadata.json"
try:
    res=json.load(open(OUT))
except Exception:
    res={}

def probe(path):
    try:
        r=subprocess.run(["ffprobe","-v","error","-show_format","-show_streams","-show_chapters","-of","json",path],
                         capture_output=True,text=True,timeout=30)
        data=json.loads(r.stdout or "{}")
    except Exception as e:
        return {"error":str(e)}
    fmt=data.get("format",{})
    out={}
    out["duration"]=float(fmt.get("duration")) if fmt.get("duration") else None
    out["format_name"]=fmt.get("format_name")
    out["size"]=int(fmt.get("size")) if fmt.get("size") else None
    vs=[s for s in data.get("streams",[]) if s.get("codec_type")=="video"]
    aus=[s for s in data.get("streams",[]) if s.get("codec_type")=="audio"]
    out["video"]=[{"codec":s.get("codec_name"),"width":s.get("width"),"height":s.get("height"),"fps":s.get("r_frame_rate"),"pix_fmt":s.get("pix_fmt")} for s in vs]
    out["audio"]=[{"codec":s.get("codec_name"),"channels":s.get("channels"),"sample_rate":s.get("sample_rate"),"language":s.get("tags",{}).get("language")} for s in aus]
    ch=data.get("chapters",[])
    out["chapters"]=[{"start":float(c.get("start_time")) if c.get("start_time") else None,"end":float(c.get("end_time")) if c.get("end_time") else None,"title":c.get("tags",{}).get("title")} for c in ch]
    out["chapter_count"]=len(ch)
    return out

for i,p in enumerate(files,1):
    if p in res:
        continue
    t=time.time()
    out=probe(p)
    res[p]=out
    with open(OUT,"w") as f:
        json.dump(res,f,indent=2)
    print(f"{i}/{len(files)} {os.path.basename(p)} dur={out.get('duration')} t={time.time()-t:.1f}", flush=True)
print("done", len(res))
