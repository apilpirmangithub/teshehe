import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { collectDashboardData } from "./dashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startDashboardServer(opts: {
    db: any;
    config: any;
    walletAddress: string;
    port?: number;
}) {
    const port = opts.port || 3001;

    const server = http.createServer(async (req, res) => {
        // Simple router
        if (req.url === "/api/data") {
            try {
                const data = await collectDashboardData(opts);
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify(data));
            } catch (err: any) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        if (req.url === "/" || req.url === "/index.html") {
            const htmlPath = path.join(__dirname, "index.html");
            if (fs.existsSync(htmlPath)) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(fs.readFileSync(htmlPath));
            } else {
                res.writeHead(404);
                res.end("Dashboard UI not found. Please build the project.");
            }
            return;
        }

        res.writeHead(404);
        res.end("Not Found");
    });

    server.listen(port, "0.0.0.0", () => {
        console.log(`[Dashboard] Web UI available at http://0.0.0.0:${port}`);
    });

    return server;
}
