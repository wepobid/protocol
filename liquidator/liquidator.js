const { createObjectFromDefaultProps } = require("../common/ObjectUtils");

class Liquidator {
  /**
   * @notice Constructs new Liquidator bot.
   * @param {Object} logger Module used to send logs.
   * @param {Object} expiringMultiPartyClient Module used to query EMP information on-chain.
   * @param {Object} gasEstimator Module used to estimate optimal gas price with which to send txns.
   * @param {Object} priceFeed Module used to query the current token price.
   * @param {String} account Ethereum account from which to send txns.
   * @param {Object} [config] Contains fields with which constructor will attempt to override defaults.
   */
  constructor(logger, expiringMultiPartyClient, gasEstimator, priceFeed, account, config) {
    this.logger = logger;
    this.account = account;

    // Expiring multiparty contract to read contract state
    this.empClient = expiringMultiPartyClient;
    this.web3 = this.empClient.web3;

    // Gas Estimator to calculate the current Fast gas rate.
    this.gasEstimator = gasEstimator;

    // Instance of the expiring multiparty to perform on-chain liquidations.
    this.empContract = this.empClient.emp;

    // Instance of the price feed to get the realtime token price.
    this.priceFeed = priceFeed;

    // The expiring multi party contract collateralization Ratio is needed to calculate minCollateralPerToken.
    this.empCRRatio = null;

    // Helper functions from web3.
    this.toBN = this.web3.utils.toBN;
    this.toWei = this.web3.utils.toWei;
    this.fromWei = this.web3.utils.fromWei;

    // Default config settings. Liquidator deployer can override these settings by passing in new
    // values via the `config` input object. The `isValid` property is a function that should be called
    // before resetting any config settings. `isValid` must return a Boolean.
    const defaultConfig = {
      crThreshold: {
        // `crThreshold`: If collateral falls more than `crThreshold` % below the min collateral requirement,
        // then it will be liquidated. For example: If the minimum collateralization ratio is 120% and the TRV is 100,
        // then the minimum collateral requirement is 120. However, if `crThreshold = 0.02`, then the minimum
        // collateral requirement is 120 * (1-0.02) = 117.6, or 2% below 120.
        value: 0.02,
        isValid: x => {
          return x < 1 && x >= 0;
        }
      },
      liquidationDeadline: {
        // `liquidationDeadline`: Aborts the liquidation if the transaction is mined this amount of time after the
        // EMP client's last update time. Denominated in seconds, so 300 = 5 minutes.
        value: 300,
        isValid: x => {
          return x >= 0;
        }
      },
      liquidationMinPrice: {
        // `liquidationMinPrice`: Aborts the liquidation if the amount of collateral in the position per token
        // outstanding is below this ratio.
        value: this.toWei("0"),
        isValid: x => {
          return this.toBN(x).gte(this.toBN("0"));
        }
        // TODO: We should specify as a percentage of the token price so that no valid
        // liquidation would ever lose money.
      },
      txnGasLimit: {
        // `txnGasLimit`: Gas limit to set for sending on-chain transactions.
        value: 9000000, // Can see recent averages here: https://etherscan.io/chart/gaslimit
        isValid: x => {
          return x >= 6000000 && x < 15000000;
        }
      }
    };

    // Validate and set config settings to class state.
    Object.assign(this, createObjectFromDefaultProps(config, defaultConfig));
  }

  // Update the client and gasEstimator clients.
  // If a client has recently updated then it will do nothing.
  update = async () => {
    await this.empClient.update();
    await this.gasEstimator.update();
    await this.priceFeed.update();

    // Fetch the collateral requirement requirement from the contract. Will only execute on first update execution.
    if (this.empCRRatio == null) {
      this.empCRRatio = await this.empContract.methods.collateralRequirement().call();
    }
  };

  // Queries underCollateralized positions and performs liquidations against any under collateralized positions.
  queryAndLiquidate = async () => {
    await this.update();

    const price = this.priceFeed.getCurrentPrice();

    if (!price) {
      this.logger.warn({
        at: "Liquidator",
        message: "Cannot liquidate: price feed returned invalid value"
      });
      return;
    }

    // The `price` is a BN that is used to determine if a position is liquidatable. The higher the
    // `price` value, the more collateral that the position is required to have to be correctly collateralized.
    // Therefore, we add a buffer by deriving scaledPrice = price * (1 - crThreshold)
    const scaledPrice = this.fromWei(
      price.mul(this.toBN(this.toWei("1")).sub(this.toBN(this.toWei(this.crThreshold.toString()))))
    );

    // Calculate the maxCollateralPerToken as the scaled price, multiplied by the contracts CRRatio. For a liquidation
    // to be accepted by the contract the position's collateralization ratio must be between [minCollateralPerToken,
    // maxCollateralPerToken] ∴ maxCollateralPerToken >= startCollateralNetOfWithdrawal / startTokens. This criterion
    // checks for a positions correct capitalization, not collateralization. In order to liquidate a position that is
    // under collaterelaized (but over capitalized) The CR ratio needs to be included in the maxCollateralPerToken.
    const maxCollateralPerToken = this.toBN(scaledPrice)
      .mul(this.toBN(this.empCRRatio))
      .div(this.toBN(this.toWei("1")));

    this.logger.debug({
      at: "Liquidator",
      message: "Scaling down collateral threshold for liquidations",
      inputPrice: price.toString(),
      scaledPrice: scaledPrice.toString(),
      empCRRatio: this.empCRRatio.toString(),
      maxCollateralPerToken: maxCollateralPerToken.toString(),
      crThreshold: this.crThreshold
    });

    this.logger.debug({
      at: "Liquidator",
      message: "Checking for under collateralized positions",
      scaledPrice: scaledPrice.toString()
    });

    // Get the latest undercollateralized positions from the client.
    const underCollateralizedPositions = this.empClient.getUnderCollateralizedPositions(scaledPrice);

    if (underCollateralizedPositions.length === 0) {
      this.logger.debug({
        at: "Liquidator",
        message: "No undercollateralized position"
      });
      return;
    }

    for (const position of underCollateralizedPositions) {
      // Note: query the time again during each iteration to ensure the deadline is set reasonably.
      const currentBlockTime = this.empClient.getLastUpdateTime();

      // Create the liquidation transaction.
      const liquidation = this.empContract.methods.createLiquidation(
        position.sponsor,
        { rawValue: this.liquidationMinPrice },
        { rawValue: maxCollateralPerToken.toString() },
        { rawValue: position.numTokens },
        parseInt(currentBlockTime) + this.liquidationDeadline
      );

      // Simple version of inventory management: simulate the transaction and assume that if it fails, the caller didn't have enough collateral.
      try {
        await liquidation.call({ from: this.account });
      } catch (error) {
        this.logger.error({
          at: "Liquidator",
          message:
            "Cannot liquidate position: not enough synthetic (or large enough approval) to initiate liquidation✋",
          sponsor: position.sponsor,
          inputPrice: scaledPrice.toString(),
          position: position,
          error: new Error(error)
        });
        continue;
      }

      const txnConfig = {
        from: this.account,
        gas: this.txnGasLimit,
        gasPrice: this.gasEstimator.getCurrentFastPrice()
      };
      this.logger.debug({
        at: "Liquidator",
        message: "Liquidating position",
        position: position,
        inputPrice: scaledPrice.toString(),
        txnConfig
      });

      // Send the transaction or report failure.
      let receipt;
      try {
        receipt = await liquidation.send(txnConfig);
      } catch (error) {
        this.logger.error({
          at: "Liquidator",
          message: "Failed to liquidate position🚨",
          error: new Error(error)
        });
        continue;
      }

      const logResult = {
        tx: receipt.transactionHash,
        sponsor: receipt.events.LiquidationCreated.returnValues.sponsor,
        liquidator: receipt.events.LiquidationCreated.returnValues.liquidator,
        liquidationId: receipt.events.LiquidationCreated.returnValues.liquidationId,
        tokensOutstanding: receipt.events.LiquidationCreated.returnValues.tokensOutstanding,
        lockedCollateral: receipt.events.LiquidationCreated.returnValues.lockedCollateral,
        liquidatedCollateral: receipt.events.LiquidationCreated.returnValues.liquidatedCollateral
      };
      this.logger.info({
        at: "Liquidator",
        message: "Position has been liquidated!🔫",
        position: position,
        inputPrice: scaledPrice.toString(),
        txnConfig,
        liquidationResult: logResult
      });
    }

    // Update the EMP Client since we created new liquidations.
    await this.empClient.update();
  };

  // Queries ongoing liquidations and attempts to withdraw rewards from both expired and disputed liquidations.
  queryAndWithdrawRewards = async () => {
    this.logger.debug({
      at: "Liquidator",
      message: "Checking for expired and disputed liquidations to withdraw rewards from"
    });

    await this.update();

    // All of the liquidations that we could withdraw rewards from are drawn from the pool of
    // expired and disputed liquidations.
    const expiredLiquidations = this.empClient.getExpiredLiquidations();
    const disputedLiquidations = this.empClient.getDisputedLiquidations();
    const potentialWithdrawableLiquidations = expiredLiquidations
      .concat(disputedLiquidations)
      .filter(liquidation => liquidation.liquidator === this.account);

    if (potentialWithdrawableLiquidations.length === 0) {
      this.logger.debug({
        at: "Liquidator",
        message: "No withdrawable liquidations"
      });
      return;
    }

    for (const liquidation of potentialWithdrawableLiquidations) {
      // Construct transaction.
      const withdraw = this.empContract.methods.withdrawLiquidation(liquidation.id, liquidation.sponsor);

      // Confirm that liquidation has eligible rewards to be withdrawn.
      let withdrawAmount;
      try {
        withdrawAmount = await withdraw.call({ from: this.account });
      } catch (error) {
        this.logger.debug({
          at: "Liquidator",
          message: "No rewards to withdraw",
          liquidation: liquidation,
          error: new Error(error)
        });
        continue;
      }

      const txnConfig = {
        from: this.account,
        gas: this.txnGasLimit,
        gasPrice: this.gasEstimator.getCurrentFastPrice()
      };
      this.logger.debug({
        at: "Liquidator",
        message: "Withdrawing liquidation",
        liquidation: liquidation,
        amount: withdrawAmount.rawValue.toString(),
        txnConfig
      });

      // Send the transaction or report failure.
      let receipt;
      try {
        receipt = await withdraw.send(txnConfig);
      } catch (error) {
        this.logger.error({
          at: "Liquidator",
          message: "Failed to withdraw liquidation rewards🚨",
          error: new Error(error)
        });
        continue;
      }

      const logResult = {
        tx: receipt.transactionHash,
        caller: receipt.events.LiquidationWithdrawn.returnValues.caller,
        withdrawalAmount: receipt.events.LiquidationWithdrawn.returnValues.withdrawalAmount,
        liquidationStatus: receipt.events.LiquidationWithdrawn.returnValues.liquidationStatus
      };
      this.logger.info({
        at: "Liquidator",
        message: "Liquidation withdrawn🤑",
        liquidation: liquidation,
        amount: withdrawAmount.rawValue.toString(),
        txnConfig,
        liquidationResult: logResult
      });
    }

    // Update the EMP Client since we withdrew rewards.
    await this.empClient.update();
  };
}

module.exports = {
  Liquidator
};
