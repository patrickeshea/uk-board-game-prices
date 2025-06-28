// server.js - Backend server for UK Board Game Price Finder
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve frontend files

// BGG API functions
async function searchBGG(query) {
    try {
        console.log(`Searching BGG for: ${query}`);
        const response = await fetch(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame&exact=0`);
        
        if (!response.ok) {
            throw new Error(`BGG API returned status: ${response.status}`);
        }
        
        const xmlText = await response.text();
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xmlText);
        
        if (!result.items || !result.items.item || result.items.item.length === 0) {
            return null;
        }
        
        // BGG returns results in relevance/popularity order, so let's use that intelligently
        const items = result.items.item;
        let bestMatch = null;
        
        const queryLower = query.toLowerCase().trim();
        
        // Strategy 1: Look for exact matches first (case insensitive)
        for (let item of items) {
            const name = item.name[0].$.value.toLowerCase();
            if (name === queryLower) {
                bestMatch = item;
                console.log(`Found exact match: ${item.name[0].$.value}`);
                break;
            }
        }
        
        // Strategy 2: If no exact match, prefer base games over expansions for generic searches
        if (!bestMatch) {
            // Check if this looks like a search for a base game (single word or well-known title)
            const isLikelyBaseGameSearch = !queryLower.includes('expansion') && 
                                         !queryLower.includes('extension') && 
                                         !queryLower.includes('fan pack') &&
                                         !queryLower.includes('promo');
            
            if (isLikelyBaseGameSearch) {
                // Look for the first result that's likely a base game
                for (let item of items) {
                    const name = item.name[0].$.value.toLowerCase();
                    
                    // Skip obvious expansions/accessories unless specifically searched for
                    const isExpansion = name.includes('expansion') || name.includes('extension') || 
                                       name.includes('fan pack') || name.includes('promo') ||
                                       name.includes('accessory') || name.includes(': ');
                    
                    if (!isExpansion && name.includes(queryLower)) {
                        bestMatch = item;
                        console.log(`Found base game match: ${item.name[0].$.value}`);
                        break;
                    }
                }
            }
        }
        
        // Strategy 3: If still no match, take the first result (trust BGG's ranking)
        if (!bestMatch) {
            bestMatch = items[0];
            console.log(`Using BGG's top result: ${bestMatch.name[0].$.value}`);
        }
        
        const name = bestMatch.name[0].$.value;
        const year = bestMatch.yearpublished ? bestMatch.yearpublished[0].$.value : 'Unknown';
        const id = bestMatch.$.id;
        
        console.log(`Final selection: ${name} (${year}) - ID: ${id}`);
        
        return {
            id: id,
            name: name,
            year: year
        };
    } catch (error) {
        console.error('BGG search error:', error);
        throw error;
    }
}

async function getBGGMarketplace(bggId) {
    try {
        console.log(`Searching BGG marketplace for ID: ${bggId}`);
        
        const response = await fetch(`https://boardgamegeek.com/xmlapi2/thing?id=${bggId}&marketplace=1`);
        
        if (!response.ok) {
            console.log(`BGG marketplace API returned status: ${response.status}`);
            return [];
        }
        
        const xmlText = await response.text();
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xmlText);
        
        if (!result.items || !result.items.item || !result.items.item[0].marketplacelistings) {
            console.log('No marketplace listings found');
            return [];
        }
        
        const listings = result.items.item[0].marketplacelistings[0].listing || [];
        console.log(`Found ${listings.length} total marketplace listings`);
        
        const gbpPrices = [];
        
        for (let i = 0; i < listings.length; i++) {
            const listing = listings[i];
            
            const price = listing.price ? listing.price[0] : null;
            const condition = listing.condition ? listing.condition[0] : null;
            const notes = listing.notes ? listing.notes[0].$.value || '' : '';
            
            if (price) {
                const currency = price.$.currency;
                const value = parseFloat(price.$.value);
                
                // ONLY include GBP listings (UK offers)
                if (currency === 'GBP') {
                    gbpPrices.push({
                        price: value,
                        originalPrice: value,
                        originalCurrency: currency,
                        condition: condition ? condition.$.value : 'Unknown',
                        notes: notes.slice(0, 100),
                        currency: 'GBP'
                    });
                }
            }
        }
        
        console.log(`Found ${gbpPrices.length} GBP (UK) marketplace listings`);
        
        // Sort by price and return all GBP listings
        return gbpPrices.sort((a, b) => a.price - b.price);
        
    } catch (error) {
        console.error('BGG Marketplace error:', error);
        return [];
    }
}

async function getBoardGamePrices(bggId) {
    try {
        console.log(`Getting BoardGamePrices for BGG ID: ${bggId}`);
        
        const response = await fetch(`https://boardgameprices.co.uk/api/info?eid=${bggId}&currency=GBP&destination=GB&sitename=boardgame-price-finder.com`);
        
        if (!response.ok) {
            console.log(`BoardGamePrices API returned status: ${response.status}`);
            return [];
        }
        
        const data = await response.json();
        
        if (!data.items || data.items.length === 0) {
            console.log('No items found in BoardGamePrices response');
            return [];
        }
        
        const item = data.items[0];
        if (!item.prices) {
            console.log('No prices found for item');
            return [];
        }
        
        console.log(`Found ${item.prices.length} retail prices`);
        
        return item.prices.map(price => ({
            store: `UK Store`, 
            price: parseFloat(price.price),
            productPrice: parseFloat(price.product),
            shipping: parseFloat(price.shipping),
            inStock: price.stock === 'Y',
            country: price.country || 'UK',
            currency: data.currency || 'GBP',
            link: price.link
        })).filter(price => price.inStock) // Only show in-stock items
          .sort((a, b) => a.price - b.price)
          .slice(0, 15);
        
    } catch (error) {
        console.error('BoardGamePrices error:', error);
        return [];
    }
}

// API Routes
app.get('/api/search/:query', async (req, res) => {
    try {
        const query = req.params.query;
        console.log(`API search request for: ${query}`);
        
        // Search BGG for game info
        const gameInfo = await searchBGG(query);
        if (!gameInfo) {
            return res.status(404).json({ error: 'Game not found on BoardGameGeek' });
        }
        
        // Get prices from both sources
        const [retailPrices, marketplacePrices] = await Promise.all([
            getBoardGamePrices(gameInfo.id),
            getBGGMarketplace(gameInfo.id)
        ]);
        
        res.json({
            game: gameInfo,
            retailPrices: retailPrices,
            marketplacePrices: marketplacePrices,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🎲 UK Board Game Price Finder API running on port ${PORT}`);
    console.log(`🌐 Frontend available at: http://localhost:3000`);
    console.log(`🔍 API endpoint: http://localhost:3000/api/search/{game_name}`);
});

module.exports = app;