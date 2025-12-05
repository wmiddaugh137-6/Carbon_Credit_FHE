pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract CarbonCreditMarketplaceFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error InvalidParameters();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedSet(bool paused);
    event CooldownSecondsSet(uint32 cooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event OrderSubmitted(address indexed submitter, uint256 batchId, bytes32 indexed encryptedData);
    event DecryptionRequested(uint256 requestId, uint256 batchId);
    event DecryptionCompleted(uint256 requestId, uint256 batchId, uint256 totalVolume, uint256 totalValue);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct Order {
        euint32 quantity;
        euint32 pricePerUnit;
    }

    uint256 public constant BATCH_LIMIT = 5;
    uint32 public cooldownSeconds = 30;

    address public owner;
    bool public paused;
    uint256 public currentBatchId;
    uint256 public openBatchId;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    mapping(uint256 => mapping(uint256 => Order)) public batchOrders;
    mapping(uint256 => uint256) public batchOrderCount;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
    }

    function addProvider(address _provider) external onlyOwner {
        if (_provider == address(0)) revert InvalidParameters();
        if (!isProvider[_provider]) {
            isProvider[_provider] = true;
            emit ProviderAdded(_provider);
        }
    }

    function removeProvider(address _provider) external onlyOwner {
        if (isProvider[_provider]) {
            isProvider[_provider] = false;
            emit ProviderRemoved(_provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setCooldownSeconds(uint32 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameters();
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(_cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (openBatchId != 0) revert InvalidBatch();
        currentBatchId++;
        openBatchId = currentBatchId;
        emit BatchOpened(openBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (openBatchId == 0) revert InvalidBatch();
        uint256 batchIdToClose = openBatchId;
        openBatchId = 0;
        emit BatchClosed(batchIdToClose);
    }

    function submitOrder(
        euint32 _encryptedQuantity,
        euint32 _encryptedPricePerUnit
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (openBatchId == 0) revert InvalidBatch();
        if (batchOrderCount[openBatchId] >= BATCH_LIMIT) revert InvalidBatch();

        lastSubmissionTime[msg.sender] = block.timestamp;

        uint256 orderId = batchOrderCount[openBatchId]++;
        batchOrders[openBatchId][orderId] = Order(_encryptedQuantity, _encryptedPricePerUnit);

        bytes32 dataToHash = keccak256(abi.encodePacked(msg.sender, openBatchId, orderId));
        emit OrderSubmitted(msg.sender, openBatchId, dataToHash);
    }

    function requestBatchSummary(uint256 _batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (_batchId == 0 || _batchId > currentBatchId) revert InvalidBatch();
        if (batchOrderCount[_batchId] == 0) revert InvalidBatch();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        uint256 numOrders = batchOrderCount[_batchId];
        euint32 totalEncryptedVolume;
        euint32 totalEncryptedValue;

        bool initialized = false;
        for (uint256 i = 0; i < numOrders; i++) {
            Order storage order = batchOrders[_batchId][i];
            if (!FHE.isInitialized(order.quantity)) _initIfNeeded(order.quantity);
            if (!FHE.isInitialized(order.pricePerUnit)) _initIfNeeded(order.pricePerUnit);

            if (!initialized) {
                totalEncryptedVolume = order.quantity;
                totalEncryptedValue = order.quantity.mul(order.pricePerUnit);
                initialized = true;
            } else {
                totalEncryptedVolume = totalEncryptedVolume.add(order.quantity);
                totalEncryptedValue = totalEncryptedValue.add(order.quantity.mul(order.pricePerUnit));
            }
        }

        euint32[] memory cts = new euint32[](2);
        cts[0] = totalEncryptedVolume;
        cts[1] = totalEncryptedValue;

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: _batchId, stateHash: stateHash, processed: false });

        emit DecryptionRequested(requestId, _batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        if (msg.sender != FHE_ORCHESTRATOR) revert NotOwner(); // FHE_ORCHESTRATOR from SepoliaConfig

        DecryptionContext storage ctx = decryptionContexts[requestId];
        euint32[] memory cts = new euint32[](2);
        cts[0] = batchOrders[ctx.batchId][0].quantity; // Placeholder for re-calculating hash
        cts[1] = batchOrders[ctx.batchId][0].pricePerUnit; // Placeholder for re-calculating hash

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        (uint32 totalVolume, uint32 totalValue) = abi.decode(cleartexts, (uint32, uint32));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, totalVolume, totalValue);
    }

    function _hashCiphertexts(euint32[] memory _cts) internal pure returns (bytes32) {
        bytes32[] memory ctsAsBytes = new bytes32[](_cts.length);
        for (uint256 i = 0; i < _cts.length; i++) {
            ctsAsBytes[i] = FHE.toBytes32(_cts[i]);
        }
        return keccak256(abi.encode(ctsAsBytes, address(this)));
    }

    function _initIfNeeded(euint32 _val) internal {
        if (!FHE.isInitialized(_val)) {
            FHE.asEuint32(0); // Initialize with a default value if not already initialized
        }
    }

    function _requireInitialized(euint32 _val) internal pure {
        if (!FHE.isInitialized(_val)) revert NotInitialized();
    }
}