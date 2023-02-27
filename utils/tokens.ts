import { AbiCoder, Provider, ParamType, id, toUtf8String } from 'ethers';
import { SupportedChains } from './chains';
const NATIVE_TOKEN = 'native_token';

export type TokenInfo = {
    symbol?: string;
    decimals?: number;
    isNft?: boolean;
};

export type TokenMetadata = {
    // updater: React.Dispatch<React.SetStateAction<TokenMetadata>>;
    status: Record<string, 'pending' | 'fetched'>;
    tokens: Record<string, TokenInfo>;
};

export const defaultTokenMetadata = (): TokenMetadata => {
    return {
        // updater: () => {},
        status: SupportedChains.reduce((o, chain) => {
            return {
                ...o,
                [chain.nativeTokenAddress]: 'fetched',
            };
        }, {}),
        tokens: SupportedChains.reduce((o, chain) => {
            return {
                ...o,
                [chain.nativeTokenAddress]: {
                    symbol: chain.nativeSymbol,
                    decimals: 18,
                    isNft: false,
                },
            };
        }, {}),
    };
};

export const fetchTokenMetadata = async (
    prevState: TokenMetadata,
    provider: Provider,
    tokens: Array<string>,
): Promise<TokenMetadata> => {
    const filteredTokens = tokens.filter(
        (token) => prevState.status[token] === undefined && token != NATIVE_TOKEN,
    );

    if (filteredTokens.length === 0) {
        return prevState;
    }

    const newState = { ...prevState };
    filteredTokens.forEach((token) => (newState.status[token] = 'pending'));

    const results = await Promise.all(
        filteredTokens
            .map((token) => {
                return [
                    provider
                        .call({
                            to: token,
                            data: id('decimals()').substring(0, 10),
                        })
                        .then((decimalsHex) => {
                            const decimals = BigInt(decimalsHex);

                            if (decimals > 255n) {
                                throw new Error(
                                    `tried to fetch decimals for token ${token} but got illegal value ${decimalsHex}`,
                                );
                            }

                            return {
                                token: token,
                                type: 'decimals',
                                decimals: Number(decimals),
                            } as { token: string; type: 'decimals'; decimals: number };
                        })
                        .catch(console.error),
                    provider
                        .call({
                            to: token,
                            data: id('symbol()').substring(0, 10),
                        })
                        .then((symbolHex) => {
                            let symbol;

                            if (symbolHex.length === 66) {
                                symbol = toUtf8String(symbolHex.replace(/(00)+$/g, ''));
                            } else {
                                try {
                                    let results = AbiCoder.defaultAbiCoder().decode(
                                        [ParamType.from('string')],
                                        symbolHex,
                                    );
                                    symbol = results[0].toString();
                                } catch (e) {
                                    throw new Error(
                                        `tried to fetch symbol for token ${token} but got illegal value ${symbolHex}`,
                                    );
                                }
                            }

                            return {
                                token: token,
                                type: 'symbol',
                                symbol: symbol,
                            } as { token: string; type: 'symbol'; symbol: string };
                        })
                        .catch(console.error),
                    provider
                        .call({
                            to: token,
                            data:
                                id('supportsInterface(bytes4)').substring(0, 10) +
                                AbiCoder.defaultAbiCoder().encode(['bytes4'], ['0x80ac58cd']).substring(2),
                        })
                        .then((isNftHex) => {
                            const isNft = isNftHex.length > 2 ? BigInt(isNftHex) == 1n : false;

                            return {
                                token: token,
                                type: 'isNft',
                                isNft: isNft,
                            } as { token: string; type: 'isNft'; isNft: boolean };
                        })
                        .catch(console.error),
                ];
            })
            .flatMap((x) => x),
    )
    filteredTokens.forEach((token) => {
        newState.status[token] = 'fetched';
        newState.tokens[token] = {};
    });

    results.forEach((result) => {
        if (!result) return;

        if (result.type === 'decimals') {
            newState.tokens[result.token].decimals = result.decimals;
        } else if (result.type === 'symbol') {
            newState.tokens[result.token].symbol = result.symbol;
        } else if (result.type === 'isNft') {
            newState.tokens[result.token].isNft = result.isNft;
        }
    });
    return newState;
};
