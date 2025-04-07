import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { format, subMonths, addDays } from 'date-fns';

// Define storage state file path
const storageStatePath = path.join(process.cwd(), 'sessionData.json');
const outputJsonPath = path.join(process.cwd(), 'twitter_messages.json');
const outputCsvPath = path.join(process.cwd(), 'twitter_messages.csv');

// Get date 3 months ago from today
const threeMonthsAgo = subMonths(new Date(), 1);
console.log(`Collecting messages from ${threeMonthsAgo.toISOString()} to now`);

async function runTwitterBot() {
    let context;
    let browser;

    try {
        browser = await chromium.launch({
            headless: false,
            slowMo: 50 // Slight slowdown for stability
        });

        // Check if we have saved storage state
        const hasStorageState = fs.existsSync(storageStatePath);

        // Create context with stored cookies if available
        context = await browser.newContext({
            storageState: hasStorageState ? storageStatePath : undefined,
            viewport: { width: 1280, height: 800 }
        });

        const page = await context.newPage();

        if (!hasStorageState) {
            console.log('No saved login found. Please login to X...');
            await page.goto('https://x.com/login');

            // Wait for login with extended timeout
            await Promise.race([
                page.waitForURL('https://x.com/home*', { timeout: 120000 }),
                page.waitForURL('https://x.com/?*', { timeout: 120000 }),
                page.waitForURL('https://x.com/i/*', { timeout: 120000 })
            ]).catch(async (error) => {
                if (error.name === 'TimeoutError') {
                    console.log('Still waiting for login... Take your time.');
                    await page.waitForURL('https://x.com/**/*', { timeout: 120000 });
                }
            });

            // Save storage state after successful login
            await context.storageState({ path: storageStatePath });
            console.log('Login data saved for future use!');
        } else {
            console.log('Using saved login data...');
            await page.goto('https://x.com/home');
        }

        console.log('Navigating to messages...');
        await page.goto('https://x.com/messages');
        await page.waitForLoadState('networkidle', { timeout: 60000 });

        // Get your own Twitter handle
        const myHandle = await page.evaluate(() => {
            const navItems = document.querySelectorAll('[data-testid="AppTabBar_Profile_Link"]');
            for (const item of navItems) {
                const href = item.getAttribute('href');
                if (href && href.startsWith('/')) {
                    return href.substring(1);
                }
            }
            return null;
        });

        console.log(`Your Twitter handle: ${myHandle || 'Could not detect'}`);
        
        // Wait for conversation list to load
        await page.waitForSelector('[data-testid="conversation"]', { timeout: 30000 });
        
        // Extract message data with mouse-based scrolling
        const messagesData = await extractMessageData(page, myHandle, threeMonthsAgo);
        
        // Clean up and validate the data
        const cleanedData = messagesData.filter(msg => {
            // Filter out invalid profile IDs (e.g., group conversations)
            return !msg.profile_id.includes('/');
        });
        
        console.log(`Found ${messagesData.length} conversations, ${cleanedData.length} valid after cleaning`);
        
        // Save to JSON file
        fs.writeFileSync(outputJsonPath, JSON.stringify(cleanedData, null, 2));
        console.log(`Message data saved to ${outputJsonPath}`);

        // Convert to CSV and save
        const csvData = convertToCSV(cleanedData);
        fs.writeFileSync(outputCsvPath, csvData);
        console.log(`Message data saved to ${outputCsvPath}`);

        console.log('Script finished.');
        await page.pause(); // Keep browser open for inspection

    } catch (error) {
        console.error('Error occurred:', error.message);
    } finally {
        if (context) await context.close();
        if (browser) await browser.close();
    }
}

async function extractMessageData(page, myHandle, cutoffDate) {
    console.log('Extracting message data...');
    
    const messages = [];
    let reachedEnd = false;
    let scrollCount = 0;
    const maxScrolls = 500;
    let noNewDataCount = 0;
    
    // Keep track of conversations we've already processed
    const processedConversations = new Set();
    
    // Track the oldest date we've seen
    let oldestDate = new Date();

    // DEMO MODE - Only process first 10 conversations
    const DEMO_MODE = true;
    const DEMO_LIMIT = 10;
    let demoCount = 0;
    
    while (!reachedEnd && scrollCount < maxScrolls) {
        // Wait for content to stabilize
        await page.waitForTimeout(1500);
        
        // Get current conversation elements
        const conversations = await page.$$('[data-testid="conversation"]');
        let newConversationsFound = 0;
        
        console.log(`Processing ${conversations.length} visible conversations...`);
        
        // Process each conversation that we haven't seen yet
        for (const conversation of conversations) {
            try {
                // DEMO MODE - Check if we've reached the limit
                if (DEMO_MODE && demoCount >= DEMO_LIMIT) {
                    console.log('Demo mode: Reached conversation limit');
                    reachedEnd = true;
                    break;
                }
                
                // Check if the conversation is actually visible
                const isVisible = await conversation.isVisible();
                if (!isVisible) continue;
                
                // Extract profile ID (handle)
                const profileHandle = await conversation.evaluate(el => {
                    const handleElement = el.querySelector('[data-testid="DM_Conversation_Avatar"]');
                    if (handleElement) {
                        const href = handleElement.getAttribute('href');
                        return href ? href.substring(1) : null;
                    }
                    return null;
                });
                
                // Skip if we couldn't extract a handle or we've already processed this conversation
                if (!profileHandle || processedConversations.has(profileHandle)) {
                    continue;
                }

                console.log(`Processing conversation with ${profileHandle} (${demoCount + 1}/${DEMO_LIMIT})`);

                // Click on the conversation to open it
                await conversation.click();
                await page.waitForTimeout(1000);

                // Extract all messages from this conversation in order
                const conversationMessages = await page.evaluate((myHandle) => {
                    const messageElements = Array.from(document.querySelectorAll('[data-testid="messageEntry"]'));
                    const messages = [];
                    let currentDate = null;
                    
                    // Process messages in order (top to bottom)
                    messageElements.forEach(message => {
                        // Get message text
                        const textElement = message.querySelector('[data-testid="tweetText"]');
                        const text = textElement ? textElement.textContent.trim() : '';
                        
                        // Get timestamp
                        const timeElement = message.querySelector('time');
                        const timestamp = timeElement ? timeElement.getAttribute('datetime') : null;
                        
                        // Check if message is sent by me (right side)
                        const isSent = message.classList.contains('r-obd0qt') || 
                                     message.querySelector('button[data-testid="messageEntry"]')?.classList.contains('r-obd0qt');
                        
                        // Get quoted tweet if exists
                        const quotedTweet = message.querySelector('[data-testid="DMCompositeMessage"]');
                        let quotedContent = null;
                        if (quotedTweet) {
                            const quotedText = quotedTweet.querySelector('[data-testid="tweetText"]');
                            const quotedUser = quotedTweet.querySelector('[data-testid="User-Name"]');
                            quotedContent = {
                                text: quotedText ? quotedText.textContent.trim() : '',
                                user: quotedUser ? quotedUser.textContent.trim() : ''
                            };
                        }
                        
                        // Get date if it's a new date
                        const dateElement = message.querySelector('div[dir="ltr"] time');
                        if (dateElement) {
                            const dateText = dateElement.getAttribute('datetime');
                            if (dateText) {
                                currentDate = new Date(dateText).toISOString().split('T')[0];
                            }
                        }
                        
                        // Add message to array
                        messages.push({
                            text,
                            timestamp,
                            is_sent: isSent,
                            position: isSent ? 'sent by me' : 'sent by user',
                            date: currentDate,
                            quoted_content: quotedContent
                        });
                    });
                    
                    return messages;
                }, myHandle);

                // Sort messages by timestamp
                const sortedMessages = conversationMessages.sort((a, b) => {
                    return new Date(a.timestamp) - new Date(b.timestamp);
                });

                // Group messages by date
                const messagesByDate = {};
                sortedMessages.forEach(msg => {
                    if (!messagesByDate[msg.date]) {
                        messagesByDate[msg.date] = [];
                    }
                    messagesByDate[msg.date].push(msg);
                });

                // Add messages to our main array with date-wise organization
                messages.push({
                    profile_id: profileHandle,
                    messages_by_date: messagesByDate,
                    total_messages: sortedMessages.length,
                    first_message_date: sortedMessages[0]?.date,
                    last_message_date: sortedMessages[sortedMessages.length - 1]?.date
                });

                // Mark this conversation as processed
                processedConversations.add(profileHandle);
                newConversationsFound++;
                demoCount++;

                // Go back to conversation list using keyboard shortcut
                await page.keyboard.press('Escape');
                await page.waitForTimeout(500); // Reduced wait time

            } catch (error) {
                console.error(`Error processing conversation: ${error.message}`);
                continue;
            }
        }
        
        // If we didn't find any new conversations, increment the counter
        if (newConversationsFound === 0) {
            noNewDataCount++;
            if (noNewDataCount >= 3) {
                console.log('No new conversations found after multiple attempts. Ending scroll.');
                reachedEnd = true;
            }
        } else {
            noNewDataCount = 0;
        }
        
        // Scroll down to load more conversations
        if (!reachedEnd) {
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight);
            });
            scrollCount++;
            await page.waitForTimeout(1000);
        }
    }
    
    return messages;
}

async function mouseBasedScrolling(page) {
    // Get viewport dimensions
    const viewportSize = page.viewportSize();
    const width = viewportSize.width;
    const height = viewportSize.height;
    
    let scrollSucceeded = false;
    
    
    // Method 3: Enhanced wheel events with smaller increments
    if (!scrollSucceeded) {
        try {
            // Move mouse to center of conversation list first
            await page.mouse.move(width / 2, height / 2);
            await page.waitForTimeout(300);
            
            // Send multiple smaller wheel events
            for (let i = 0; i < 15; i++) {
                await page.mouse.wheel(0, 80);
                await page.waitForTimeout(100);
            }
            
            console.log("Mouse wheel scroll completed");
            scrollSucceeded = true;
        } catch (wheelError) {
            console.log("Mouse wheel scrolling failed:", wheelError.message);
        }
    }
    
    // Method 4: Element-based scrolling with updated selectors
    if (!scrollSucceeded) {
        try {
            await page.evaluate(() => {
                // Try multiple potential container selectors
                const selectors = [
                    '[data-testid="DM_ScrollerContainer"]',
                    '[aria-label*="Timeline: Messages"]',
                    '[aria-label*="Conversation"]',
                    '[data-testid="primaryColumn"]',
                    '[data-testid="DMDrawer"]',
                    'div[role="region"]',
                    'main[role="main"]',
                    'section[role="region"]'
                ];
                
                for (const selector of selectors) {
                    const container = document.querySelector(selector);
                    if (container) {
                        const originalScrollTop = container.scrollTop;
                        container.scrollTop += 500;
                        
                        // Check if scrolling worked
                        if (container.scrollTop > originalScrollTop) {
                            console.log(`Found scrollable container: ${selector}`);
                            return true;
                        }
                    }
                }
                
                // Last resort: window scroll
                const originalScrollY = window.scrollY;
                window.scrollBy(0, 500);
                return window.scrollY > originalScrollY;
            });
            await page.waitForTimeout(800);
            console.log("Element-based scroll completed");
            scrollSucceeded = true;
        } catch (error) {
            console.log("Element-based scrolling failed:", error.message);
        }
    }
    
    // Method 5: Combined keyboard approach
    if (!scrollSucceeded) {
        try {
            // Try different key combinations
            await page.keyboard.press('End');
            await page.waitForTimeout(500);
            await page.keyboard.press('Home');
            await page.waitForTimeout(500);
            await page.keyboard.press('PageDown');
            await page.waitForTimeout(500);
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(100);
            for (let i = 0; i < 10; i++) {
                await page.keyboard.press('ArrowDown');
                await page.waitForTimeout(50);
            }
            console.log("Keyboard navigation used");
            scrollSucceeded = true;
        } catch (keyError) {
            console.log("Keyboard navigation failed:", keyError.message);
        }
    }
    
    // Method 6: Absolute last resort - click and drag using specific coordinates
    if (!scrollSucceeded) {
        try {
            // Try clicking on the far right scrollbar area
            await page.mouse.move(width - 10, height / 2);
            await page.mouse.down();
            await page.waitForTimeout(300);
            await page.mouse.move(width - 10, 100, { steps: 10 });
            await page.waitForTimeout(300);
            await page.mouse.up();
            console.log("Scrollbar drag attempted");
            scrollSucceeded = true;
        } catch (error) {
            console.log("Scrollbar drag failed:", error.message);
        }
    }
    
    // Wait longer for content to load
    await page.waitForTimeout(2500);
    
    return true;
}

function convertToCSV(messages) {
    // CSV header
    let csv = 'Profile ID,Date,Timestamp,Message,Sender,Quoted Text,Quoted User\n';
    
    // Process each conversation
    messages.forEach(conversation => {
        const profileId = conversation.profile_id;
        
        // Process each date's messages
        Object.entries(conversation.messages_by_date).forEach(([date, messages]) => {
            messages.forEach(msg => {
                // Escape special characters and wrap in quotes
                const escapedText = `"${msg.text.replace(/"/g, '""')}"`;
                const quotedText = msg.quoted_content ? `"${msg.quoted_content.text.replace(/"/g, '""')}"` : '';
                const quotedUser = msg.quoted_content ? `"${msg.quoted_content.user.replace(/"/g, '""')}"` : '';
                
                // Add row to CSV
                csv += `${profileId},${date},${msg.timestamp},${escapedText},${msg.position},${quotedText},${quotedUser}\n`;
            });
        });
    });
    
    return csv;
}

runTwitterBot().catch(console.error);