'use strict'
const _ = require('lodash');
const assert = require('assert');
const BigNumber = require('bignumber.js');
const cw3p = require('create-web3-provider');
const ethjstx = require('ethereumjs-tx').Transaction;
const ethjscom = require('ethereumjs-common').default;
const ethjs = require('ethereumjs-util');

const util = require('./util');
const Resolver = require('./resolver');
const RpcClient = require('./rpc-client');
const createTransactionPromise = require('./transaction-promise');

module.exports = class FlexEther {
	constructor(opts={}) {
		this.provider = opts.provider;
		if (!this.provider) {
			this.provider = cw3p({
				ws: opts.ws,
				infuraKey: opts.infuraKey,
				network: opts.network,
				uri: opts.providerURI,
				net: opts.net,
			});
		}
		this.rpc = new RpcClient(this.provider);
		this._resolver = new Resolver(this.rpc, opts.ens);
		this.gasBonus = _.isNumber(opts.gasBonus) ? opts.gasBonus : 0.66;
		this.gasPriceBonus = _.isNumber(opts.gasPriceBonus) ?
			opts.gasPriceBonus : -0.005;
		this.maxGasPrice = opts.maxGasPrice || new BigNumber('250e9').toString(10); // 250 gwei
	}

	async getChainId() {
		return this._chainId || (this._chainId = await this.rpc.getChainId());
	}

	async _getChainCommon() {
		if (!this._chainCommon) {
			const chainId = await this.getChainId();
			this._chainCommon = ethjscom.forCustomChain(
				'mainnet',
				{
					chainId,
					name: `FlexEther-Istanbul-${chainId}`,
				},
				'istanbul',
			);
		}
		return this._chainCommon;
	}

	async getDefaultAccount() {
		return this.rpc.getDefaultAccount();
	}

	async getTransactionCount(addr) {
		addr = await this._resolver.resolve(addr);
		return this.rpc.getTransactionCount(addr);
	}

	async getTransactionReceipt(txHash) {
		return this.rpc.getTransactionReceipt(txHash);
	}

	async getTransaction(txHash) {
		return this.rpc.getTransaction(txHash);
	}

	async getBalance(addr, block='latest') {
		return this.rpc.getBalance(
			await this.resolve(addr, block),
			await this.resolveBlockDirective(block),
		);
	}

	async getGasPrice() {
		return this.rpc.getGasPrice();
	}

	async getPastLogs(filter) {
		return this.rpc.getLogs({
			...filter,
			fromBlock: !_.isNil(filter.fromBlock) ?
				await this.resolveBlockDirective(filter.fromBlock) : undefined,
			toBlock: !_.isNil(filter.toBlock) ?
				await this.resolveBlockDirective(filter.toBlock) : undefined,
			address: !_.isNil(filter.address) ?
				await this.resolve(filter.address) : undefined,
		});
	}

	async getBlock(numberOrHash='latest') {
		return this.rpc.getBlock(
			await this.resolveBlockDirective(numberOrHash),
		);
	}

	async getBlockNumber() {
		return this.rpc.getBlockNumber();
	}

	async getCode(addr, block='latest') {
		return this.rpc.getCode(
			await this.resolve(addr, block),
			await this.resolveBlockDirective(block),
		);
	}

	async _getGasPriceWithBonus(bonus) {
		bonus = (_.isNumber(bonus) ? bonus : this.gasPriceBonus) || 0;
		const price = new BigNumber(await this.getGasPrice()).times(1 + bonus);
		if (price.gt(this.maxGasPrice)) {
			price = new BigNumber(max);
		}
		return price.toString(10);
	}

	async estimateGas(to, opts={}) {
		const txOpts = await createTransactionOpts(this, to, opts);
		return await estimateGasRaw(this, txOpts, opts.block, opts.gasBonus);
	}

	send(to, opts={}) {
		return createTransactionPromise(this, sendTx(this, to, opts));
	}

	transfer(to, amount, opts) {
		return createTransactionPromise(
			this,
			sendTx(
				this,
				to,
				_.assign({}, opts, { value: amount })
			)
		);
	}

	async call(to, opts={}) {
		return callTx(this, to, opts);
	}

	async getBlockNumber() {
		return this.rpc.getBlockNumber();
	}

	async resolveBlockDirective(block=-1) {
		if (block === 'latest' || block === 'pending' || block === 'earliest') {
			return block;
		}
		if (_.isNumber(block)) {
			if (block < 0) {
				let n = await this.rpc.getBlockNumber();
				n += block + 1;
				if (n <= 0) {
					throw Error(`Block number offset is too large: ${block}`);
				}
				return n;
			}
			return block;
		}
		throw new Error(`Invalid block directive: ${block}`);
	}

	async resolve(addr, block='latest') {
		if (!addr)
			throw new Error(`Invalid address: "${addr}"`);
		return this._resolver.resolve(addr, block);
	}
};

async function getBlockGasLimit(inst) {
	while (true) {
		const lastBlock = await inst.getBlock();
		if (lastBlock != null)
			return lastBlock.gasLimit;
	}
}

async function estimateGasRaw(inst, txOpts, block, bonus) {
	txOpts = _.assign({}, txOpts, {
			gasPrice: 1,
			gasLimit: await getBlockGasLimit(inst),
		});
	bonus = (_.isNumber(bonus) ? bonus : inst.gasBonus) || 0;
	block = _.isNil(block)
		? undefined : await inst.resolveBlockDirective(block);
	const gas = await inst.rpc.estimateGas(normalizeTxOpts(txOpts), block);
	return Math.ceil(gas * (1+bonus));
}

async function createTransactionOpts(inst, to, opts) {
	let from = undefined;
	if (opts.from === null) {
		// Explicitly leaving it undefined.
	} else if (_.isString(opts.from)) {
		from = await inst.resolve(opts.from, opts.block);
	} else if (_.isNumber(opts.from)) {
		from = opts.from;
	} else if (opts.key)
		from = util.privateKeyToAddress(opts.key);
	else
		from = await inst.getDefaultAccount();
	to = to ? await inst.resolve(to, opts.block) : undefined;
	return {
		gasPrice: opts.gasPrice,
		gasLimit: opts.gasLimit || opts.gas,
		value: opts.value || 0,
		data: opts.data,
		to: to,
		from: from
	};
}

function normalizeTxOpts(opts) {
	const _opts = {};
	_opts.gasPrice = util.toHex(opts.gasPrice || 0);
	_opts.gas = util.toHex(opts.gasLimit || opts.gas || 0);
	_opts.value = util.toHex(opts.value || 0);
	if (!_.isNil(opts.nonce))
		_opts.nonce = util.toHex(opts.nonce);
	if (opts.data && opts.data != '0x')
		_opts.data = util.toHex(opts.data);
	else
		_opts.data = '0x';
	if (_.isString(opts.to))
		_opts.to = ethjs.toChecksumAddress(opts.to);
	if (_.isString(opts.from))
		_opts.from = ethjs.toChecksumAddress(opts.from);
	return _opts;
}

async function callTx(inst, to, opts) {
	const block = _.isNil(opts.block)
		? undefined : await inst.resolveBlockDirective(opts.block);
	const overrides = _.isNil(opts.overrides)
		? undefined
		: _.zipObject(
			await Promise.all(
				Object.keys(opts.overrides).map(k => inst.resolve(k, opts.block)),
			),
			Object.values(opts.overrides),
		);
	const txOpts = await createTransactionOpts(inst, to, opts);
	_.defaults(txOpts, {
			gasPrice: 1,
			gasLimit: await getBlockGasLimit(inst)
		});
	if (!txOpts.to && (!txOpts.data || txOpts.data == '0x'))
		throw Error('Transaction has no destination.');
	return inst.rpc.call(normalizeTxOpts(txOpts), block, overrides);
}

async function sendTx(inst, to, opts) {
	const txOpts = await createTransactionOpts(inst, to, opts);
	if (!txOpts.from)
		throw Error('Cannot determine caller.');
	if (!txOpts.to && (!txOpts.data || txOpts.data == '0x'))
		throw Error('Transaction has no destination.');
	if (_.isNumber(opts.nonce))
		txOpts.nonce = opts.nonce;
	else
		txOpts.nonce = await inst.getTransactionCount(txOpts.from);
	if (!txOpts.gasPrice)
		txOpts.gasPrice = await inst.getGasPrice(opts.gasPriceBonus);
	if (!txOpts.gasLimit)
		txOpts.gasLimit = await estimateGasRaw(inst, txOpts, undefined, opts.gasBonus);
	if (!txOpts.chainId)
		txOpts.chainId = await inst._chainId;
	if (opts.key) {
		// Sign the TX ourselves.
		const tx = new ethjstx(
			normalizeTxOpts(txOpts),
			{ common: await inst._getChainCommon() },
		);
		tx.sign(ethjs.toBuffer(opts.key));
		const serialized = util.asBytes(tx.serialize());
		return inst.rpc.sendRawTransaction(serialized);
	}
	// Let the provider sign it.
	return inst.rpc.sendTransaction(normalizeTxOpts(txOpts));
}

module.exports.util = util;
