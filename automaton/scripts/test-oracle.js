
import { createPublicClient, http, getAddress, formatEther } from 'viem';
import { base } from 'viem/chains';

const PERPS_MARKET_PROXY = getAddress("0x0A2AF931eFFd34b81ebcc57E3d3c9B1E1dE1C9Ce");
const PERPS_ABI = [{
    name: "indexPrice",
    inputs: [{ name: "marketId", type: "uint128" }],
    outputs: [{ name: "price", type: "uint256" }],
    stateMutability: "view",
    type: "function",
}];

async function test() {
    const client = createPublicClient({ chain: base, transport: http() });
    try {
        console.log("Calling indexPrice(100) on", PERPS_MARKET_PROXY);
        const price = await client.readContract({
            address: PERPS_MARKET_PROXY,
            abi: PERPS_ABI,
            functionName: "indexPrice",
            args: [100n],
        });
        console.log("Price:", formatEther(price));
    } catch (err) {
        console.error("FAILED:", err.message);
    }
}
test();
