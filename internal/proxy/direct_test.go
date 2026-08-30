package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

func TestBuildUpstreamURLTimeshiftPath(t *testing.T) {
	p := provider.Provider{Host:"http://provider.test", LocalUsername:"local", LocalPassword:"secret", UpstreamUsername:"up", UpstreamPassword:"pass"}
	r := httptest.NewRequest(http.MethodGet,"http://proxy/timeshift/local/secret/60/2026-08-30:01-00/123.ts",nil)
	target, endpoint, err := buildUpstreamURL(routing.Resolved{Provider:p,RemainingPath:r.URL.Path},r)
	if err != nil { t.Fatal(err) }
	if endpoint != "timeshift" { t.Fatalf("endpoint=%q",endpoint) }
	want := "/timeshift/up/pass/60/2026-08-30:01-00/123.ts"
	if target.Path != want { t.Fatalf("path=%q want=%q",target.Path,want) }
}

func TestBuildUpstreamURLStreamingTimeshiftQuery(t *testing.T) {
	p := provider.Provider{Host:"http://provider.test", LocalUsername:"local", LocalPassword:"secret", UpstreamUsername:"up", UpstreamPassword:"pass"}
	r := httptest.NewRequest(http.MethodGet,"http://proxy/streaming/timeshift.php?username=local&password=secret&stream=123&duration=60",nil)
	target, _, err := buildUpstreamURL(routing.Resolved{Provider:p,RemainingPath:r.URL.Path},r)
	if err != nil { t.Fatal(err) }
	q:=target.Query(); if q.Get("username")!="up"||q.Get("password")!="pass"||q.Get("stream")!="123" { t.Fatalf("query=%v",q) }
}

func TestServeDirectPreservesRangeAndPartialContent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		if got:=r.Header.Get("Range");got!="bytes=10-19"{t.Errorf("Range=%q",got)}
		if got:=r.Header.Get("If-Range");got!="etag-1"{t.Errorf("If-Range=%q",got)}
		w.Header().Set("Accept-Ranges","bytes");w.Header().Set("Content-Range","bytes 10-19/100");w.Header().Set("Content-Length","10");w.WriteHeader(http.StatusPartialContent);_,_=w.Write([]byte("0123456789"))
	})); defer upstream.Close()
	target,_:=url.Parse(upstream.URL+"/movie/up/pass/55.mp4")
	h:=&Handler{streamClient:upstream.Client()}
	r:=httptest.NewRequest(http.MethodGet,"http://proxy/movie/local/secret/55.mp4",nil);r.Header.Set("Range","bytes=10-19");r.Header.Set("If-Range","etag-1")
	w:=httptest.NewRecorder();h.serveDirect(w,r,provider.Provider{},target)
	resp:=w.Result();defer resp.Body.Close();if resp.StatusCode!=http.StatusPartialContent{t.Fatalf("status=%d",resp.StatusCode)};if resp.Header.Get("Content-Range")!="bytes 10-19/100"{t.Fatalf("Content-Range=%q",resp.Header.Get("Content-Range"))};if resp.Header.Get("Accept-Ranges")!="bytes"{t.Fatalf("Accept-Ranges=%q",resp.Header.Get("Accept-Ranges"))}
}
