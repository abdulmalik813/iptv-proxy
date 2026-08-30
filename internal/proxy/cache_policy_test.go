package proxy

import (
	"net/url"
	"testing"
)

func TestCachePolicyOnlyCachesSharedCatalogResponses(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		query    url.Values
		want     bool
	}{
		{name: "live categories", endpoint: "player_api.php", query: url.Values{"action": {"get_live_categories"}}, want: true},
		{name: "live streams full list", endpoint: "player_api.php", query: url.Values{"action": {"get_live_streams"}}, want: true},
		{name: "vod categories", endpoint: "player_api.php", query: url.Values{"action": {"get_vod_categories"}}, want: true},
		{name: "vod streams full list", endpoint: "player_api.php", query: url.Values{"action": {"get_vod_streams"}}, want: true},
		{name: "series categories", endpoint: "player_api.php", query: url.Values{"action": {"get_series_categories"}}, want: true},
		{name: "series full list", endpoint: "player_api.php", query: url.Values{"action": {"get_series"}}, want: true},
		{name: "vod detail is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_vod_info"}, "vod_id": {"123"}}, want: false},
		{name: "series detail is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_series_info"}, "series_id": {"123"}}, want: false},
		{name: "short epg is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_short_epg"}, "stream_id": {"123"}}, want: false},
		{name: "simple epg table is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_simple_data_table"}, "stream_id": {"123"}}, want: false},
		{name: "category filtered live list is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_live_streams"}, "category_id": {"7"}}, want: false},
		{name: "category filtered vod list is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_vod_streams"}, "category_id": {"7"}}, want: false},
		{name: "category filtered series list is direct", endpoint: "player_api.php", query: url.Values{"action": {"get_series"}, "category_id": {"7"}}, want: false},
		{name: "xmltv", endpoint: "xmltv.php", query: url.Values{}, want: true},
		{name: "xmltv arbitrary variant is direct", endpoint: "xmltv.php", query: url.Values{"foo": {"bar"}}, want: false},
		{name: "m3u playlist", endpoint: "get.php", query: url.Values{"type": {"m3u_plus"}, "output": {"ts"}}, want: true},
		{name: "m3u arbitrary variant is direct", endpoint: "get.php", query: url.Values{"type": {"m3u_plus"}, "output": {"ts"}, "foo": {"bar"}}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isCacheable(tt.endpoint, tt.query); got != tt.want {
				t.Fatalf("isCacheable(%q, %v) = %v, want %v", tt.endpoint, tt.query, got, tt.want)
			}
		})
	}
}
