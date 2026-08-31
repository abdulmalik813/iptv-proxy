package proxy

func isDirectMediaEndpoint(endpoint string) bool {
	switch endpoint {
	case "live", "movie", "series", "timeshift", "streaming", "hls":
		return true
	default:
		return false
	}
}
