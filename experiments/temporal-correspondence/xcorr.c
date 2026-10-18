#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

typedef struct { double re, im; } Cplx;

static void fft(Cplx *a, int n, int invert) {
    for (int i=1,j=0;i<n;i++){
        int bit=n>>1;
        for(; j&bit; bit>>=1) j^=bit;
        j^=bit;
        if(i<j){ Cplx t=a[i]; a[i]=a[j]; a[j]=t; }
    }
    for(int len=2;len<=n;len<<=1){
        double ang = (invert? 6.283185307179586 : -6.283185307179586)/len;
        Cplx wlen = {cos(ang), sin(ang)};
        for(int i=0;i<n;i+=len){
            Cplx w={1,0};
            for(int j=0;j<len/2;j++){
                Cplx u=a[i+j];
                Cplx v={a[i+j+len/2].re*w.re - a[i+j+len/2].im*w.im,
                        a[i+j+len/2].re*w.im + a[i+j+len/2].im*w.re};
                a[i+j].re=u.re+v.re; a[i+j].im=u.im+v.im;
                a[i+j+len/2].re=u.re-v.re; a[i+j+len/2].im=u.im-v.im;
                double wr=w.re*wlen.re - w.im*wlen.im;
                double wi=w.re*wlen.im + w.im*wlen.re;
                w.re=wr; w.im=wi;
            }
        }
    }
    if(invert){
        for(int i=0;i<n;i++){ a[i].re/=n; a[i].im/=n; }
    }
}

int main(int argc,char**argv){
    if(argc<3){ fprintf(stderr,"usage: xcorr a.pcm b.pcm [maxlag_sec] [sr]\n"); return 1; }
    int sr = argc>4 ? atoi(argv[4]) : 1000;
    int maxlag = argc>3 ? atoi(argv[3]) : 90;
    // read files
    FILE *fa=fopen(argv[1],"rb"), *fb=fopen(argv[2],"rb");
    if(!fa||!fb){ perror("open"); return 1; }
    fseek(fa,0,SEEK_END); long sa=ftell(fa); fseek(fa,0,SEEK_SET);
    fseek(fb,0,SEEK_END); long sb=ftell(fb); fseek(fb,0,SEEK_SET);
    int na=sa/2, nb=sb/2;
    short *a=malloc(na*sizeof(short)), *b=malloc(nb*sizeof(short));
    fread(a,2,na,fa); fread(b,2,nb,fb);
    fclose(fa); fclose(fb);
    // remove DC
    double ma=0,mb=0; for(int i=0;i<na;i++) ma+=a[i]; ma/=na;
    for(int i=0;i<nb;i++) mb+=b[i]; mb/=nb;
    int n=1; while(n < na+nb) n<<=1;
    Cplx *A=calloc(n,sizeof(Cplx)), *B=calloc(n,sizeof(Cplx));
    for(int i=0;i<na;i++) A[i].re = a[i]-ma;
    for(int i=0;i<nb;i++) B[i].re = b[i]-mb;
    fft(A,n,0); fft(B,n,0);
    // cross-correlation: IFFT(conj(A)*B) gives corr at lag? We'll compute and inspect.
    for(int i=0;i<n;i++){
        double re = A[i].re*B[i].re + A[i].im*B[i].im; // conj(A)*B? conj(A)=(re,-im); product with B: re*B.re + im*B.im? Let's do conj(A)*B = (A.re - i A.im)(B.re + i B.im) = A.re B.re + A.im B.im + i(A.re B.im - A.im B.re)
        double im = A[i].re*B[i].im - A[i].im*B[i].re;
        A[i].re=re; A[i].im=im;
    }
    fft(A,n,1); // now A holds correlation
    // lag k corresponds index k for k<=n/2? correlation[k] = sum_i A[i] B[i+k]? Need map. We'll just search all and convert.
    // We want lag in samples where B is shifted relative to A. Try indices 0..maxlag*sr and n-maxlag*sr..n-1.
    int bestidx=0; double bestval=-1e18, bestabs=0;
    // collect top peaks
    // search positive lags: index k (B delayed by k)
    int maxl = maxlag*sr;
    if(maxl > n/2) maxl=n/2;
    // We'll scan k from -maxl to maxl
    double energyA=0,energyB=0;
    for(int i=0;i<na;i++) energyA += (a[i]-ma)*(a[i]-ma);
    for(int i=0;i<nb;i++) energyB += (b[i]-mb)*(b[i]-mb);
    double norm = sqrt(energyA*energyB);
    // print header
    printf("na=%d nb=%d n=%d sr=%d maxlag=%d\n", na, nb, n, sr, maxlag);
    // find top 10 by abs
    // simple: iterate k
    int topk[10]; double topv[10];
    for(int t=0;t<10;t++){ topk[t]=0; topv[t]=-1; }
    for(int k=-maxl;k<=maxl;k++){
        int idx = (k>=0)? k : n+k;
        double v = A[idx].re / norm;
        // insert top
        for(int t=0;t<10;t++){
            if(fabs(v) > fabs(topv[t])){
                for(int u=9;u>t;u--){ topv[u]=topv[u-1]; topk[u]=topk[u-1]; }
                topv[t]=v; topk[t]=k; break;
            }
        }
        if(fabs(v)>bestabs){ bestabs=fabs(v); bestidx=k; bestval=v; }
    }
    printf("best_lag_sec=%.3f corr=%.4f\n", bestidx/(double)sr, bestval);
    printf("top_peaks (lag_sec, corr):\n");
    for(int t=0;t<10;t++){
        printf("  %+.3f  %.4f\n", topk[t]/(double)sr, topv[t]);
    }
    return 0;
}
