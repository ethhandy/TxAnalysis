import { ChainConfig } from './chains';

const NATIVE_TOKEN = 'native_token';

type CoinInfo = {
    confidence: number;
    decimals: number;
    price: number;
    symbol: string;
    timestamp: number;
};

type DefiLlamaResponse = {
    coins: Record<string, CoinInfo>;
};

export type PriceInfo = {
    decimals: number;
    currentPrice: bigint;
    historicalPrice: bigint;
};

export type PriceMetadata = {
    // updater: React.Dispatch<React.SetStateAction<PriceMetadata>>;
    status: Record<string, 'pending' | 'fetched'>;
    prices: Record<string, PriceInfo>;
};

export const defaultPriceMetadata = (): PriceMetadata => {
    return {
        // updater: () => {},
        status: {},
        prices: {},
    };
};

export const toDefiLlamaId = (chainInfo: ChainConfig, token: string) => {
    if (token === chainInfo.nativeTokenAddress || token == NATIVE_TOKEN) {
        return chainInfo.coingeckoId;
    }

    return `${chainInfo.defillamaPrefix}:${token}`;
};

export const getPriceOfToken = (
    metadata: PriceMetadata,
    id: string,
    amount: bigint,
    type: 'current' | 'historical',
): bigint | null => {
    if (metadata.status[id] !== 'fetched') return null;

    const priceInfo = metadata.prices[id];
    return (
        amount *
        BigInt(10 ** (18 - priceInfo.decimals)) *
        (type === 'current' ? priceInfo.currentPrice : priceInfo.historicalPrice)
    );
};

export const fetchDefiLlamaPrices = async (
    prevState: PriceMetadata,
    ids: string[],
    when: number,
): Promise<PriceMetadata> => {
    const newState = { ...prevState };

    const filteredIds = ids.filter((id) => newState.status[id] === undefined);

    if (filteredIds.length === 0) {
        return prevState;
    }

    filteredIds.forEach((id) => (newState.status[id] = 'pending'));
    const [current, historical] = await Promise.all([
        fetch(`https://coins.llama.fi/prices/current/${filteredIds.join(',')}`)
            .then((resp) => resp.json())
            .then((resp) => resp.coins),
        fetch(`https://coins.llama.fi/prices/historical/${when}/${filteredIds.join(',')}`)
            .then((resp) => resp.json())
            .then((resp) => resp.coins),
    ])
    filteredIds.forEach((id) => {
        newState.status[id] = 'fetched';
        newState.prices[id] = {
            decimals: 18,
            currentPrice: 0n,
            historicalPrice: 0n,
        };

        if (current[id]) {
            if (current[id].decimals) {
                newState.prices[id].decimals = current[id].decimals;
            }
            newState.prices[id].currentPrice = BigInt((current[id].price * 10000) | 0);
        }
        if (historical[id]) {
            if (historical[id].decimals) {
                newState.prices[id].decimals = historical[id].decimals;
            }
            newState.prices[id].historicalPrice = BigInt((historical[id].price * 10000) | 0);
        }
    });

    return newState;
};
