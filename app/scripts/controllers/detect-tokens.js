import Web3 from 'web3';
import { warn } from 'loglevel';
import { MINUTE } from '../../../shared/constants/time';
import { isTokenDetectionEnabledForNetwork } from '../../../shared/modules/network.utils';
import { isEqualCaseInsensitive } from '../../../shared/modules/string-utils';
import { TOKEN_STANDARDS } from '../../../ui/helpers/constants/common';
import { ASSET_TYPES } from '../../../shared/constants/transaction';
import { EVENT, EVENT_NAMES } from '../../../shared/constants/metametrics';

// By default, poll every 3 minutes
const DEFAULT_INTERVAL = MINUTE * 3;

/**
 * A controller that polls for token exchange
 * rates based on a user's current token list
 */
export default class DetectTokensController {
  /**
   * Creates a DetectTokensController
   *
   * @param {Object} [config] - Options to configure controller
   * @param config.interval
   * @param config.preferences
   * @param config.network
   * @param config.keyringMemStore
   * @param config.tokenList
   * @param config.tokensController
   * @param config.assetsContractController
   * @param config.trackMetaMetricsEvent
   */
  constructor({
    interval = DEFAULT_INTERVAL,
    preferences,
    network,
    keyringMemStore,
    tokenList,
    tokensController,
    assetsContractController = null,
    trackMetaMetricsEvent,
  } = {}) {
    this.assetsContractController = assetsContractController;
    this.tokensController = tokensController;
    this.preferences = preferences;
    this.interval = interval;
    this.network = network;
    this.keyringMemStore = keyringMemStore;
    this.tokenList = tokenList;
    this.selectedAddress = this.preferences?.store.getState().selectedAddress;
    this.useTokenDetection = this.preferences?.store.getState().useTokenDetection;
    this.tokenAddresses = this.tokensController?.state.tokens.map((token) => {
      return token.address;
    });
    this.hiddenTokens = this.tokensController?.state.ignoredTokens;
    this.detectedTokens = this.tokensController?.state.detectedTokens;
    this._trackMetaMetricsEvent = trackMetaMetricsEvent;

    preferences?.store.subscribe(({ selectedAddress, useTokenDetection }) => {
      if (
        this.selectedAddress !== selectedAddress ||
        this.useTokenDetection !== useTokenDetection
      ) {
        this.selectedAddress = selectedAddress;
        this.useTokenDetection = useTokenDetection;
        this.restartTokenDetection();
      }
    });
    tokensController?.subscribe(
      ({ tokens = [], ignoredTokens = [], detectedTokens = [] }) => {
        this.tokenAddresses = tokens.map((token) => {
          return token.address;
        });
        this.hiddenTokens = ignoredTokens;
        this.detectedTokens = detectedTokens;
      },
    );
  }

  /**
   * For each token in the tokenlist provided by the TokenListController, check selectedAddress balance.
   */
  async detectNewTokens() {
    if (!this.isActive) {
      return;
    }
    if (
      !this.useTokenDetection ||
      !isTokenDetectionEnabledForNetwork(
        this._network.store.getState().provider.chainId,
      )
    ) {
      return;
    }

    const { tokenList } = this._tokenList.state;

    const tokensToDetect = [];
    this.web3.setProvider(this._network._provider);
    for (const tokenAddress in tokenList) {
      if (
        !this.tokenAddresses.find((address) =>
          isEqualCaseInsensitive(address, tokenAddress),
        ) &&
        !this.hiddenTokens.find((address) =>
          isEqualCaseInsensitive(address, tokenAddress),
        ) &&
        !this.detectedTokens.find(({ address }) =>
          isEqualCaseInsensitive(address, tokenAddress),
        )
      ) {
        tokensToDetect.push(tokenAddress);
      }
    }
    const sliceOfTokensToDetect = [
      tokensToDetect.slice(0, 1000),
      tokensToDetect.slice(1000, tokensToDetect.length - 1),
    ];
    for (const tokensSlice of sliceOfTokensToDetect) {
      let result;
      try {
        result = await this.assetsContractController.getBalancesInSingleCall(
          this.selectedAddress,
          tokensSlice,
        );
      } catch (error) {
        warn(
          `MetaMask - DetectTokensController single call balance fetch failed`,
          error,
        );
        return;
      }

      const tokensWithBalance = [];
      if (result) {
        const eventTokensDetails = [];
        const nonZeroTokenAddresses = Object.keys(result);
        for (const nonZeroTokenAddress of nonZeroTokenAddresses) {
          const { address, symbol, decimals, iconUrl, aggregators } = tokenList[
            nonZeroTokenAddress
          ];

          eventTokensDetails.push(`${symbol} - ${address}`);

          tokensWithBalance.push({
            address,
            symbol,
            decimals,
            image: iconUrl,
            aggregators,
          });
        }

        if (tokensWithBalance.length > 0) {
          this._trackMetaMetricsEvent({
            event: EVENT_NAMES.TOKEN_DETECTED,
            category: EVENT.CATEGORIES.WALLET,
            properties: {
              tokens: eventTokensDetails,
              token_standard: TOKEN_STANDARDS.ERC20,
              asset_type: ASSET_TYPES.TOKEN,
            },
          });
          await this.tokensController.addDetectedTokens(tokensWithBalance);
        }
      }
    }
  }

  /**
   * Restart token detection polling period and call detectNewTokens
   * in case of address change or user session initialization.
   *
   */
  restartTokenDetection() {
    if (!(this.isActive && this.selectedAddress)) {
      return;
    }
    this.detectNewTokens();
    this.interval = DEFAULT_INTERVAL;
  }

  /* eslint-disable accessor-pairs */
  /**
   * @type {number}
   */
  set interval(interval) {
    this._handle && clearInterval(this._handle);
    if (!interval) {
      return;
    }
    this._handle = setInterval(() => {
      this.detectNewTokens();
    }, interval);
  }

  /**
   * @type {Object}
   */
  set network(network) {
    if (!network) {
      return;
    }
    this._network = network;
    this.web3 = new Web3(network._provider);
  }

  /**
   * In setter when isUnlocked is updated to true, detectNewTokens and restart polling
   *
   * @type {Object}
   */
  set keyringMemStore(keyringMemStore) {
    if (!keyringMemStore) {
      return;
    }
    this._keyringMemStore = keyringMemStore;
    this._keyringMemStore.subscribe(({ isUnlocked }) => {
      if (this.isUnlocked !== isUnlocked) {
        this.isUnlocked = isUnlocked;
        if (isUnlocked) {
          this.restartTokenDetection();
        }
      }
    });
  }

  /**
   * @type {Object}
   */
  set tokenList(tokenList) {
    if (!tokenList) {
      return;
    }
    this._tokenList = tokenList;
  }

  /**
   * Internal isActive state
   *
   * @type {Object}
   */
  get isActive() {
    return this.isOpen && this.isUnlocked;
  }
  /* eslint-enable accessor-pairs */
}
