
import { BigNumberish, formatUnits, ParamType } from 'ethers';
import { TraceMetadata } from './types';
import { TraceEntry, TraceEntryCall } from './api';

// lmao ethers wtf
export const BuiltinErrors: Record<
    string,
    { signature: string; inputs: Array<ParamType>; name: string; reason?: boolean }
> = {
    '0x08c379a0': {
        signature: 'Error(string)',
        name: 'Error',
        inputs: [ParamType.from('string message')],
        reason: true,
    },
    '0x4e487b71': { signature: 'Panic(uint256)', name: 'Panic', inputs: [ParamType.from('uint256 code')] },
};

export const toHash = (value: bigint): string => {
    return '0x' + value.toString(16).padStart(64, '0');
};

export const chunkString = (str: string, len: number): string[] => {
    const size = Math.ceil(str.length / len);
    const r = Array(size);
    let offset = 0;

    for (let i = 0; i < size; i++) {
        r[i] = str.substring(offset, offset + len);
        offset += len;
    }

    return r;
};

export const findAffectedContract = (metadata: TraceMetadata, node: TraceEntry): [TraceEntryCall, TraceEntryCall[]] => {
    let path: TraceEntryCall[] = [];

    let parents = node.path.split('.');

    while (parents.length > 0) {
        parents.pop();

        let parentNode = metadata.nodesByPath[parents.join('.')];
        if (parentNode.type === 'call') {
            path.push(parentNode);

            if (parentNode.variant !== 'delegatecall') {
                path.reverse();

                return [parentNode, path];
            }
        }
    }

    throw new Error("strange, didn't find parent node");
};

export const formatUnitsSmartly = (value: bigint, nativeUnit?: string): string => {
    nativeUnit = (nativeUnit || 'eth').toUpperCase();

    if (value === 0n) {
        return `0 ${nativeUnit}`;
    }

    let chosenUnit;
    if (value >= 100000000000000n) {
        chosenUnit = 'ether';
    } else if (value >= 100000n) {
        chosenUnit = 'gwei';
    } else {
        chosenUnit = 'wei';
    }

    let formattedValue = formatUnits(value, chosenUnit);

    if (chosenUnit === 'ether') {
        chosenUnit = nativeUnit;
    }

    return `${formattedValue} ${chosenUnit}`;
};

export const formatUsd = (val: bigint): string => {
    let formatted = formatUnits(val, 22);
    let [left, right] = formatted.split('.');

    // we want at least 4 decimal places on the right
    right = right.substring(0, 4).padEnd(4, '0');

    const isNegative = left.startsWith('-');
    if (isNegative) {
        left = left.substring(1);
    }

    // we want comma delimited triplets on the left
    if (left.length > 3) {
        let parts = [];
        if (left.length % 3 !== 0) {
            parts.push(left.substring(0, left.length % 3));
            left = left.substring(left.length % 3);
        }
        parts.push(chunkString(left, 3));

        left = parts.join(',');
    }

    return `${isNegative ? '-' : ''}${left}.${right.substring(0, 4)} USD`;
};
