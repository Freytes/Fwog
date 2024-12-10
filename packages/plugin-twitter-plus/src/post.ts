import { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    embeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    parseBooleanFromText,
    elizaLogger,
} from "@ai16z/eliza";
import { TemplateEnhancedTwitterClient } from "./template-enhanced-client.ts";
import type { SpecialInteraction } from "./environment.ts";
import { validateTwitterConfig } from "./environment.ts";
import { sample } from 'lodash';
import { TwitterClient } from "./twitter-client.ts";
import { TwitterPlusClient } from "./twitter-plus-client.ts";

const MAX_TWEET_LENGTH = 280;

interface PostSchedule {
    minMinutes: number;
    maxMinutes: number;
    lastPostTime: number;
}

interface PostResponse {
    content: string;
    isSpecialInteraction: boolean;
    interactionType?: string;
}

function truncateToCompleteSentence(text: string): string {
    if (text.length <= MAX_TWEET_LENGTH) {
        return text;
    }

    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", MAX_TWEET_LENGTH)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}

export class TwitterPostClient {
    private client: TwitterClient | TwitterPlusClient;
    private runtime: IAgentRuntime;
    private schedule: PostSchedule;
    private isPosting: boolean = false;
    private lastSpecialInteraction: Record<string, number> = {};
    private specialInteractions: Record<string, SpecialInteraction> = {};
    private specialInteractionCooldown: number = 24 * 60 * 60 * 1000;

    constructor(client: TwitterClient | TwitterPlusClient, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;

        this.schedule = {
            minMinutes: parseInt(runtime.getSetting("POST_INTERVAL_MIN")) || 90,
            maxMinutes: parseInt(runtime.getSetting("POST_INTERVAL_MAX")) || 180,
            lastPostTime: 0
        };
    }

    public setSpecialInteractions(interactions: Record<string, SpecialInteraction>): void {
        this.specialInteractions = interactions;
        Object.keys(interactions).forEach(key => {
            this.lastSpecialInteraction[key] = 0;
        });
    }

    async start(postImmediately: boolean = false): Promise<void> {
        try {
            await this.initializePostSchedule();
            await this.startPostingLoop(postImmediately);
        } catch (error) {
            elizaLogger.error("Error starting post client:", error);
            throw error;
        }
    }

    private async initializePostSchedule(): Promise<void> {
        const lastPost = await this.runtime.cacheManager.get<{
            timestamp: number;
        }>(
            `twitter/${this.runtime.getSetting("TWITTER_USERNAME")}/lastPost`
        );
        this.schedule.lastPostTime = lastPost?.timestamp ?? 0;
    }

    private async startPostingLoop(postImmediately: boolean): Promise<void> {
        const generateNewTweetLoop = async (): Promise<void> => {
            try {
                const now = Date.now();
                const timeSinceLastPost = now - this.schedule.lastPostTime;
                const randomMinutes = Math.floor(
                    Math.random() *
                    (this.schedule.maxMinutes - this.schedule.minMinutes + 1)
                ) + this.schedule.minMinutes;
                const delay = randomMinutes * 60 * 1000;

                if (timeSinceLastPost >= delay && !this.isPosting) {
                    await this.generateNewTweet();
                }

                setTimeout(() => generateNewTweetLoop(), delay);
                elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
            } catch (error) {
                elizaLogger.error("Error in tweet generation loop:", error);
                setTimeout(() => generateNewTweetLoop(), 5 * 60 * 1000);
            }
        };

        if (postImmediately || parseBooleanFromText(this.runtime.getSetting("POST_IMMEDIATELY"))) {
            await this.generateNewTweet();
        }

        generateNewTweetLoop();
    }

    private async generateTweetContent(): Promise<PostResponse> {
        try {
            const context = {
                isReply: false,
                specialInteractions: this.specialInteractions,
                postSchedule: this.schedule,
                lastSpecialInteraction: this.lastSpecialInteraction
            };

            const content = await this.client.generateTweetContent(context);

            return {
                content: truncateToCompleteSentence(content),
                isSpecialInteraction: false
            };
        } catch (error) {
            elizaLogger.error("Error generating tweet content:", error);
            throw error;
        }
    }

    private async generateNewTweet(): Promise<void> {
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                if (this.isPosting) {
                    elizaLogger.log("Tweet generation already in progress, skipping");
                    return;
                }

                this.isPosting = true;
                const tweetResponse = await this.generateTweetContent();
                await this.postTweet(tweetResponse);
                return;
            } catch (error) {
                retryCount++;
                elizaLogger.error(`Error generating/posting tweet (attempt ${retryCount}/${maxRetries}):`, error);
                await wait(1000 * retryCount); // Exponential backoff
            } finally {
                this.isPosting = false;
            }
        }
    }

    private async postTweet(tweetResponse: PostResponse): Promise<void> {
        if (!tweetResponse.content) {
            elizaLogger.warn("No content generated for tweet");
            return;
        }

        if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
            elizaLogger.info(`Dry run: would have posted tweet: ${tweetResponse.content}`);
            return;
        }

        try {
            const tweet = await this.sendTweetAndCreateMemory(tweetResponse);
            await this.updateCaches(tweet, tweetResponse);
            elizaLogger.log(`Tweet posted: ${tweet.permanentUrl}`);
        } catch (error) {
            elizaLogger.error("Error posting tweet:", error);
            throw error;
        }
    }

    private async sendTweetAndCreateMemory(tweetResponse: PostResponse) {
        const result = await this.client.requestQueue.add(
            async () => await this.client.twitterClient.sendTweet(tweetResponse.content)
        );
        const body = await result.json();
        const tweetResult = body.data.create_tweet.tweet_results.result;

        const tweet = this.createTweetObject(tweetResult);
        await this.createMemoryForTweet(tweet, tweetResponse);

        return tweet;
    }

    private createTweetObject(tweetResult: any): Tweet {
        return {
            id: tweetResult.rest_id,
            name: this.client.profile.screenName,
            username: this.client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            timestamp: new Date(tweetResult.legacy.created_at).getTime() / 1000,
            userId: this.client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
            hashtags: tweetResult.legacy.entities?.hashtags || [],
            mentions: tweetResult.legacy.entities?.user_mentions || [],
            photos: [],
            thread: [],
            urls: tweetResult.legacy.entities?.urls || [],
            videos: [],
        };
    }

    private async createMemoryForTweet(tweet: Tweet, tweetResponse: PostResponse): Promise<void> {
        const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);

        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
                text: tweetResponse.content.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
                metadata: {
                    isSpecialInteraction: tweetResponse.isSpecialInteraction,
                    interactionType: tweetResponse.interactionType
                }
            },
            roomId,
            embedding: embeddingZeroVector,
            createdAt: tweet.timestamp * 1000,
        });
    }

    private async updateCaches(tweet: Tweet, tweetResponse: PostResponse): Promise<void> {
        let homeTimeline = await this.client.getCachedTimeline() || [];
        homeTimeline.unshift(tweet);
        await this.client.cacheTimeline(homeTimeline);
        await this.client.cacheTweet(tweet);

        const postInfo = {
            id: tweet.id,
            timestamp: Date.now(),
            type: tweetResponse.isSpecialInteraction ? tweetResponse.interactionType : 'normal'
        };

        await this.runtime.cacheManager.set(
            `twitter/${this.client.profile.username}/lastPost`,
            postInfo
        );
        this.schedule.lastPostTime = postInfo.timestamp;
    }
}

export default TwitterPostClient;
