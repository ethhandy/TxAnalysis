import { assert } from "console";
import { formatUnits, getAddress, Interface, JsonRpcProvider, Provider, TransactionReceipt } from "ethers";
import { doApiRequest, TraceEntry, TraceEntryCall, TraceEntryLog, TraceResponse } from "./api";
import { ChainConfig, getChain } from "./chains";
import { findAffectedContract, formatUsd } from "./helpers";
import { precompiles } from "./precompiles";
import { defaultPriceMetadata, fetchDefiLlamaPrices, getPriceOfToken, PriceMetadata, toDefiLlamaId } from "./prices";
import { defaultTokenMetadata, fetchTokenMetadata, TokenMetadata } from "./tokens";
import { MinedTransaction, TransactionMetadata } from "./transaction";
import { TraceMetadata } from "./types";

const chain = 'ethereum';
const NATIVE_TOKEN = 'native_token';

let customLabels: Record<string, Record<string, string>> = {};
let chainConfig: ChainConfig | undefined;
let traceResult: TraceResponse;
let traceMetadata: TraceMetadata;
let provider: Provider;
let tokenMetadata: TokenMetadata;
let priceMetadata: PriceMetadata;
let transactionMetadata: TransactionMetadata;

type AddressValueInfo = {
  hasMissingPrices: boolean;
  totalValueChange: bigint;
  changePerToken: Record<string, bigint>;
};

const computeBalanceChanges = (
    entrypoint: TraceEntryCall,
    traceMetadata: TraceMetadata,
    tokenMetadata: TokenMetadata,
    chainConfig: ChainConfig,
    priceMetadata: PriceMetadata,
): [Record<string, AddressValueInfo>, Set<string>] => {
    const changes: Record<string, AddressValueInfo> = {};
    const allTokens = new Set<string>();

    const addChange = (address: string, token: string, change: bigint) => {
        address = address.toLowerCase();
        token = token.toLowerCase();

        allTokens.add(token);

        if (tokenMetadata.status[token] === 'fetched' && tokenMetadata.tokens[token].isNft) {
            change = change > 0n ? 1n : -1n;
        }

        if (!(address in changes)) {
            changes[address] = {
                hasMissingPrices: false,
                totalValueChange: 0n,
                changePerToken: {},
            };
        }
        if (!(token in changes[address].changePerToken)) {
            changes[address].changePerToken[token] = change;
            return;
        }

        changes[address].changePerToken[token] = changes[address].changePerToken[token] + change;
    };

    const visitNode = (node: TraceEntryCall) => {
        // skip failed calls because their events don't matter
        if (node.status === 0) return;

        const value = BigInt(node.value);
        if (value != 0n) {
            addChange(node.from, NATIVE_TOKEN, -value);
            addChange(node.to, NATIVE_TOKEN, value);
        }

        node.children
            .filter((child): child is TraceEntryLog => child.type === 'log')
            .forEach((traceLog) => {
                if (traceLog.topics.length === 0) return;
                if (traceLog.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                    const [parentNode] = findAffectedContract(traceMetadata, traceLog);

                    try {
                        const parsedEvent = traceMetadata.abis[node.to][node.codehash].parseLog({
                            topics: traceLog.topics,
                            data: traceLog.data,
                        });

                        const value = parsedEvent?.args[2] as bigint;
                        addChange(parsedEvent?.args[0] as string, parentNode.to, -value);
                        addChange(parsedEvent?.args[1] as string, parentNode.to, value);
                    } catch (e) {
                        console.error('failed to process value change', e);
                    }
                } else if (
                    traceLog.topics[0] === '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'
                ) {
                    const [parentNode] = findAffectedContract(traceMetadata, traceLog);

                    try {
                        const parsedEvent = traceMetadata.abis[node.to][node.codehash].parseLog({
                            topics: traceLog.topics,
                            data: traceLog.data,
                        });

                        const value = parsedEvent?.args[1] as bigint;
                        addChange(parsedEvent?.args[0] as string, parentNode.to, -value);
                    } catch (e) {
                        console.error('failed to process value change', e);
                    }
                }
            });

        node.children.filter((child): child is TraceEntryCall => child.type === 'call').forEach(visitNode);
    };
    visitNode(entrypoint);

    for (let [addr, addrChanges] of Object.entries(changes)) {
        for (let [token, delta] of Object.entries(addrChanges)) {
            if (delta === 0n) {
                delete addrChanges.changePerToken[token];
            }
        }

        if (Object.entries(addrChanges).length === 0) {
            delete changes[addr];
        }
    }

    Object.values(changes).forEach((info) => {
        let hasMissingPrice = false;
        let changeInValue = 0n;
        Object.entries(info.changePerToken).forEach(([token, delta]) => {
            const defiLlamaId = toDefiLlamaId(chainConfig, token);

            const deltaPrice = getPriceOfToken(priceMetadata, defiLlamaId, delta, 'historical');
            if (deltaPrice === null) {
                hasMissingPrice = true;
                return;
            }

            changeInValue += deltaPrice;
        });

        info.hasMissingPrices = hasMissingPrice;
        info.totalValueChange = changeInValue;
    });

    return [changes, allTokens];
};

const tryFetchTrace = async (txhash: string) : Promise<[TraceResponse, TraceMetadata]> => {
    const traceResponse = await doApiRequest<TraceResponse>(`/api/v1/trace/${chain}/${txhash}`);
    let labels: Record<string, string> = {};
    if (!(chain in customLabels)) {
        customLabels[chain] = {};
    }

    for (let address of Object.keys(precompiles)) {
        labels[address] = 'Precompile';
    }

    let metadata: TraceMetadata = {
        abis: {},
        nodesByPath: {},
    };

    let preprocess = (node: TraceEntry) => {
        metadata.nodesByPath[node.path] = node;

        if (node.type === 'call') {
            node.children.forEach(preprocess);
        }
    };
    preprocess(traceResponse.entrypoint);

    for (let [address, entries] of Object.entries(traceResponse.addresses)) {
        metadata.abis[address] = {};
        for (let [codehash, info] of Object.entries(entries)) {
            labels[address] = labels[address] || info.label;

            try {
                console.log(info);
                metadata.abis[address][codehash] = new Interface([
                    ...Object.values(info.functions),
                    ...Object.values(info.events),
                    ...Object.values(info.errors).filter(
                        (v) =>
                            !(
                                // lmao wtf ethers
                                (
                                    (v.name === 'Error' &&
                                        v.inputs &&
                                        v.inputs.length === 1 &&
                                        v.inputs[0].type === 'string') ||
                                    (v.name === 'Panic' &&
                                        v.inputs &&
                                        v.inputs.length === 1 &&
                                        v.inputs[0].type === 'uint256')
                                )
                            ),
                    ),
                ]);
            } catch (e) {
                console.log('failed to construct interface', e);
            }
        }
    }

    for (let address of Object.keys(labels)) {
        if (labels[address] === 'Vyper_contract') {
            labels[address] = `Vyper_contract (0x${address.substring(2, 6)}..${address.substring(
                38,
                42,
            )})`;
        }
    }

    // Object.keys(labels).forEach((addr) => delete customLabels[chain][addr]);
    customLabels[chain] = labels;

    return [traceResponse, metadata];
}

const getTransactionMetadata = async (provider: Provider, txhash: string): Promise<boolean> => {
    const [number, transactionResult, receiptResult] = await Promise.allSettled([
        provider.getBlockNumber(), // make ethers fetch this so it gets batched (getTransactionReceipt really wants to know the confirmations)
        provider.getTransaction(txhash),
        provider.getTransactionReceipt(txhash),
    ]);

    if (number.status === 'rejected') {
        return false;
    }
    if (transactionResult.status === 'rejected') {
        console.log('an error occurred while loading the transaction!', transactionResult.reason);

        return false;
    }

    if (!transactionResult.value) {
        console.log('an error occurred while loading the transaction: ', 'transaction not found');
        return false;
    }

    const result: TransactionMetadata = {
        transaction: transactionResult.value,
        result: null,
    };

    const processReceipt = async (receipt: TransactionReceipt) => {
        console.log('got receipt', receipt);
        result.result = {
            receipt: receipt,
            timestamp: Math.floor(new Date().getTime() / 1000),
        } as MinedTransaction;

        transactionMetadata = result
        if (number.value - receipt.blockNumber + 1 > 2) {
            const block = await provider
                .getBlock(receipt.blockHash)
            result.result!.timestamp = block!.timestamp;

            transactionMetadata = result

            priceMetadata = await fetchDefiLlamaPrices(priceMetadata, [chainConfig!.coingeckoId], block!.timestamp);
        }

        [traceResult, traceMetadata] = await tryFetchTrace(txhash);
    };

    if (receiptResult.status === 'fulfilled' && receiptResult.value) {
        await processReceipt(receiptResult.value);
    } else {
        const r = await provider
            .waitForTransaction(txhash)
        await processReceipt(r!);
    }

    transactionMetadata = result;

    return true;
}

export default async (txhash: string) => {
    chainConfig = await getChain(chain);
    if (typeof chainConfig === 'undefined') {
        return {error: `Cannot find chain: ${chain}.`};
    }
    
    [traceResult, traceMetadata] = await tryFetchTrace(txhash);
    provider = new JsonRpcProvider(chainConfig?.rpcUrl);
    provider.getBlockNumber().catch(() => {});

    tokenMetadata = defaultTokenMetadata();
    priceMetadata = defaultPriceMetadata();
    const ok = await getTransactionMetadata(provider, txhash);
    if (ok === false) {
        return {error: `Cannot find transaction: ${txhash}.`};
    }
    
    let [changes, allTokens] = computeBalanceChanges(traceResult.entrypoint,
        traceMetadata, tokenMetadata, chainConfig, priceMetadata);
    
    if (transactionMetadata.result) {
        priceMetadata = await fetchDefiLlamaPrices(
            priceMetadata,
            Array.from(allTokens).map((token) => {
                const tokenAddress = token === NATIVE_TOKEN ? '0x0000000000000000000000000000000000000000' : token;
                return `${chainConfig?.defillamaPrefix}:${tokenAddress}`;
            }),
            transactionMetadata.result.timestamp,
        );
    }
    tokenMetadata = await fetchTokenMetadata(tokenMetadata, provider, Array.from(allTokens));

    [changes, allTokens] = computeBalanceChanges(traceResult.entrypoint,
        traceMetadata, tokenMetadata, chainConfig, priceMetadata);

    // return JSON.stringify(changes, (_, v) => typeof v === 'bigint' ? v.toString() : v);

    return Object.entries(changes).sort((a, b) => {
        if (!a[1].hasMissingPrices && !b[1].hasMissingPrices) {
            return a[1].totalValueChange > b[1].totalValueChange
                    ? -1
                    : 1
        } else if (a[1].hasMissingPrices) {
            return 1;
        } else if (b[1].hasMissingPrices) {
            return -1;
        } else {
            return 0;
        }
    }).map(entry => {
        let address = entry[0];
        address = getAddress(address.toString()).toLowerCase();
        const { hasMissingPrices, totalValueChange, changePerToken } = entry[1];
        return {
            address: customLabels[chain][address] || address,
            changeInValue: hasMissingPrices ? 'Loading...' : formatUsd(totalValueChange),
            details: Object.keys(changePerToken)
                .sort()
                .map((token) => {
                    let labels;
                    let tokenAddress = token;
                    let priceId = toDefiLlamaId(chainConfig!, token);
                    if (token === NATIVE_TOKEN) {
                        tokenAddress = chainConfig!.nativeTokenAddress || '';
                        priceId = chainConfig!.coingeckoId || '';
                        labels = { [tokenAddress]: chainConfig!.nativeSymbol || '' };
                    }
                    tokenAddress = tokenAddress.toLowerCase();

                    let amountFormatted = changePerToken[token].toString();
                    let tokenPriceRendered = 'Loading...';

                    let tokenInfo = tokenMetadata.tokens[tokenAddress];
                    if (tokenInfo !== undefined && tokenInfo.decimals !== undefined) {
                        amountFormatted = formatUnits(changePerToken[token], tokenInfo.decimals);
                    }
                    if (priceMetadata.status[priceId] === 'fetched') {
                        tokenPriceRendered = formatUsd(
                            getPriceOfToken(priceMetadata, priceId, changePerToken[token], 'historical')!,
                        );
                    }
                    
                    return {
                        label: (labels && labels[tokenAddress]) || customLabels[chain][tokenAddress] || tokenAddress,
                        amount: amountFormatted,
                        tokenPrice: tokenPriceRendered
                    }
                })
        }
    });
}