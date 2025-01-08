import { Client, IAgentRuntime, elizaLogger } from "@elizaos/core";
import createRabbiTraderPlugin from "@elizaos/plugin-rabbi-trader";

export class AutoClient {
    private interval: NodeJS.Timeout | null = null;
    private runtime: IAgentRuntime;
    private plugin: any;
    static readonly CLIENT_NAME = "auto";

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log("AutoClient constructor called");
        this.runtime = runtime;
        this.initialize();
    }

    private async initialize() {
        try {
            elizaLogger.log("AutoClient initialization started");
            await this.initializePlugin();
            elizaLogger.log("AutoClient initialization completed");
        } catch (error) {
            elizaLogger.error("AutoClient initialization failed:", error);
            throw error;
        }
    }

    private async initializePlugin() {
        try {
            elizaLogger.log("Initializing Rabbi Trader plugin in AutoClient...");

            this.plugin = await createRabbiTraderPlugin(
                (key: string) => this.runtime.getSetting(key),
                this.runtime
            );

            elizaLogger.log("Plugin created, initializing...");
            await this.plugin.initialize(this.runtime);

            elizaLogger.log("Plugin initialized, starting...");
            await this.plugin.start();

            if (this.plugin.onStart) {
                elizaLogger.log("Triggering plugin onStart...");
                await this.plugin.onStart();
            }

            elizaLogger.log("Rabbi Trader plugin fully initialized and started in AutoClient");
        } catch (error) {
            elizaLogger.error("Failed to initialize Rabbi Trader plugin in AutoClient:", {
                error,
                phase: "initialization",
                pluginState: this.plugin ? 'created' : 'null'
            });
            throw error;
        }
    }

    public async stop() {
        elizaLogger.log("Stopping AutoClient...");
        try {
            if (this.interval) {
                clearInterval(this.interval);
                this.interval = null;
            }

            if (this.plugin?.cleanup) {
                await this.plugin.cleanup();
            }

            elizaLogger.log("AutoClient stopped successfully");
        } catch (error) {
            elizaLogger.error("Error stopping AutoClient:", error);
            throw error;
        }
    }
}

export const AutoClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        elizaLogger.log("Starting AutoClient interface...");
        const client = new AutoClient(runtime);
        return client;
    },
    stop: async (runtime: IAgentRuntime) => {
        elizaLogger.log("Stopping AutoClient interface...");
        const clients = (runtime as any).clients || {};
        const client = clients["auto"] as AutoClient;
        if (client) {
            await client.stop();
        }
    }
};

export default AutoClientInterface;
