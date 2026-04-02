# Overview
we will issue a token: Hybond using Token.sol as the core token. it will be used to tokenize real world assets: a BNY ETF FUND.

## token mint workflow -> Express.sol:requestDeposit 
1. user call requestDeposit to deposit USDC to the contract at T+0
2. our fund operator will transfer the USDC to buy BNY ETF FUND offchain at T+0 EOD.
3. at T+2, BNY will email us the share price of the BNY ETF FUND, and the share amount of the BNY ETF FUND.
4. we will update the share price of the BNY ETF FUND in the contract: PriceOracle.sol, proposePrice and confirmPrice.
4. fund operator will call processDepositQueue to process the mint request in the deposit queue.
5. user will receive the Hybond tokens in the wallet, over!

## token redeem workflow -> Express.sol:requestRedeem
1. user call requestRedeem to redeem Hybond to USDC at T+0
2. our fund operator call function sharesPerToken, to calculate the real offchain shares that we will need to sell.
3. at T+2, BNY will email us the share price that we used to sell the BNY ETF FUND, and the USDC amount that we will receive.
4. fund operator will call processPendingRedeems to process the redeem request in the pending redeem queue, all the redeem requests will be moved from pending redeem queue to redeem queue; during this process, we will apply the current share price to convert the hybond tokens amount into USDC amount.
4. at T+4, we will receive the USDC from BNY, and call processRedeemQueue to process the redeem request in the redeem queue, the queue will be processed FIFO, and all hybond tokens will be burned.
5. user will receive the USDC in the wallet, over!

## requirements for management fee
1. we will call updateEpoch to update the management fee daily based on the circulating supply.
2. we will call claimMgtFee to claim the management fee monthly.
3. the off-chain bny shares equals to the circulating supply of the Hybond token, not the total supply;
4. total supply of the Hybond token = circulating supply + redeem queue shares + mgtFeeTo shares.

# Combine the workflow
1. On User Side:
1.1. a user call requestDeposit to deposit USDC to the contract at T+0
1.2. user call requestRedeem to redeem Hybond to USDC at T+0

2. On Fund Operator Side:
2.1. our fund operator will transfer the USDC to buy BNY ETF FUND offchain at T+0 EOD.
2.2. our fund operator call function sharesPerToken, to calculate the real offchain shares that we will need to sell and sell at T+0 EOD
2.3. at T+2, BNY will email us the share price of the BNY ETF FUND, and the share amount of the BNY ETF FUND.
2.4. we will update the share price of the BNY ETF FUND in the contract: PriceOracle.sol, proposePrice and confirmPrice.
2.5. fund operator will call processDepositQueue to process the mint request in the deposit queue.
2.6 fund operator will call processPendingRedeems to process the redeem request in the pending redeem queue, all the redeem requests will be moved from pending redeem queue to redeem queue; during this process, we will apply the current share price to convert the hybond tokens amount into USDC amount.
2.7 fund operator will call updateEpoch to update the management fee daily based on the circulating supply.
2.8 fund operator will call processRedeemQueue to process the redeem request in the redeem queue, the queue will be processed FIFO, and all hybond tokens will be burned.
2.7 user will receive the USDC in the wallet, over!

# The existing problem
the hybond token in circulating supply is not the same as the total supply of the Hybond token because of the management fee (when manage fee rate is not 0), the current implementation has issues in processPendingRedeems function as it will convert the original hybond tokens of each request into USDC amount, by right it should be the offchain shares that we will need to sell, which means the USDC amount in the final redeem queue will be greater than the USDC we will receive from BNY. The processRedeemQueue function will be reverted as there is no enough USDC in the contract.
