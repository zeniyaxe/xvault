"""Local static server for browser QA. Disables caching so edits show on reload.
Usage: python tools/dev-server.py [port]   (serves the repository root on 127.0.0.1)"""
import http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *args):
        pass

if __name__ == '__main__':
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    os.chdir(root)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
