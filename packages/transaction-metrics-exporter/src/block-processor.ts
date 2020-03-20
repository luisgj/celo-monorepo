import { ContractKit } from '@celo/contractkit'
import { newBlockExplorer, ParsedTx } from '@celo/contractkit/lib/explorer/block-explorer'
import { newLogExplorer } from '@celo/contractkit/lib/explorer/log-explorer'
import { labelValues } from 'prom-client'
import { Transaction } from 'web3-core'
import { Block } from 'web3-eth'

import { Counters } from './metrics'
import { Contracts, stateGetters } from './states'
import { toMethodId, toTxMap } from './utils'

enum LoggingCategory {
  Block = 'RECEIVED_BLOCK',
  ParsedLog = 'RECEIVED_PARSED_LOG',
  ParsedTransaction = 'RECEIVED_PARSED_TRANSACTION',
  State = 'RECEIVED_STATE',
  Transaction = 'RECEIVED_TRANSACTION',
  TransactionReceipt = 'RECEIVED_TRANSACTION_RECEIPT',
}

export class BlockProcessor {
  private contracts: Contracts = {} as any
  private initialized = false

  constructor(
    private kit: ContractKit,
    private blockInterval = 1,
    private fromBlock: number = 0,
    private toBlock: number = fromBlock
  ) {}

  async init() {
    if (this.initialized) {
      throw new Error('BlockProcessor is running')
    }
    this.initialized = true

    await this.loadContracts()

    if (this.fromBlock?.toFixed?.() && this.toBlock) {
      this.initBatch()
    } else {
      await this.initSubscription()
    }
  }

  async loadContracts() {
    this.contracts.Exchange = await this.kit.contracts.getExchange()
    this.contracts.SortedOracles = await this.kit.contracts.getSortedOracles()
    // this.contracts.Reserve = await this.kit.contracts.getReserve()
    this.contracts.GoldToken = await this.kit.contracts.getGoldToken()
    this.contracts.EpochRewards = await this.kit.contracts.getEpochRewards()
  }

  async initSubscription() {
    const subscription = await this.kit.web3.eth.subscribe('newBlockHeaders')

    // Prevent same block multiples times
    let lastBlocks: number[] = []
    subscription.on('data', (header) => {
      if (!lastBlocks.includes(header.number)) {
        // tslint:disable-next-line: no-floating-promises
        this.onNewBlock(header.number)
      }
      lastBlocks.push(header.number)
      lastBlocks = lastBlocks.slice(-10)
    })
  }

  async initBatch() {
    let block = this.fromBlock - 1
    while (++block <= this.toBlock) {
      await this.onNewBlock(block)
    }
  }

  async onNewBlock(blockNumber: number) {
    if (blockNumber % this.blockInterval === 0) {
      await Promise.all([this.fetchBlockState(blockNumber), this.processBlockHeader(blockNumber)])
    }
  }

  async fetchBlockState(blockNumber: number) {
    const promises = stateGetters.map(({ contract, method, args, transformValues }) => {
      this.contracts[contract].setDefaultBlock(blockNumber)
      return (this.contracts as any)[contract][method](...args)
        .then((returnData: any) => {
          this.contracts[contract].setDefaultBlock('latest')
          this.logEvent(LoggingCategory.State, {
            contract,
            function: method,
            args: JSON.stringify(args),
            blockNumber,
            values: transformValues(returnData),
          })
        })
        .catch() as Promise<any>
    })
    await Promise.all(promises)
  }

  async processBlockHeader(blockNumber: number) {
    const NOT_WHITELISTED_ADDRESS = 'not_whitelisted_address'

    const blockExplorer = await newBlockExplorer(this.kit)
    const logExplorer = await newLogExplorer(this.kit)

    const block = await blockExplorer.fetchBlock(blockNumber)
    const previousBlock: Block = await blockExplorer.fetchBlock(blockNumber - 1)

    Counters.blockheader.inc({ miner: block.miner })

    const blockTime = Number(block.timestamp) - Number(previousBlock.timestamp)
    this.logEvent(LoggingCategory.Block, { ...block, blockTime })

    const parsedBlock = blockExplorer.parseBlock(block)
    const parsedTxMap = toTxMap(parsedBlock)

    for (const tx of parsedBlock.block.transactions as Transaction[]) {
      const parsedTx: ParsedTx | undefined = parsedTxMap.get(tx.hash)

      this.logEvent(LoggingCategory.Transaction, tx)
      const receipt = await this.kit.web3.eth.getTransactionReceipt(tx.hash)
      this.logEvent(LoggingCategory.TransactionReceipt, receipt)

      // tslint:disable-next-line
      const labels = {
        to: parsedTx ? tx.to : NOT_WHITELISTED_ADDRESS,
        methodId: toMethodId(tx.input, parsedTx != null),
        status: receipt.status.toString(),
      } as labelValues

      Counters.transaction.inc(labels)
      Counters.transactionGasUsed.observe(labels, receipt.gasUsed)
      Counters.transactionLogs.inc(labels, (receipt.logs || []).length)

      if (parsedTx) {
        Counters.parsedTransaction.inc({
          contract: parsedTx.callDetails.contract,
          function: parsedTx.callDetails.function,
        })

        this.logEvent(LoggingCategory.ParsedTransaction, { ...parsedTx.callDetails, hash: tx.hash })

        for (const event of logExplorer.getKnownLogs(receipt)) {
          Counters.transactionParsedLogs.inc({
            contract: parsedTx.callDetails.contract,
            function: parsedTx.callDetails.function,
            log: event.event,
          })

          // @ts-ignore We want to rename event => eventName to avoid overwriting
          event.eventName = event.event
          delete event.event

          this.logEvent(LoggingCategory.ParsedLog, event)
        }
      }
    }
  }

  private logEvent(name: string, details: object) {
    console.log(JSON.stringify({ event: name, ...details }))
  }
}
