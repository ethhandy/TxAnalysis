import { TransactionReceipt, TransactionResponse } from 'ethers';

export type MinedTransaction = {
    receipt: TransactionReceipt;
    timestamp: number;
};

export type TransactionMetadata = {
    transaction: TransactionResponse;
    result: MinedTransaction | null;
};
