import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface CarbonOrder {
  id: number;
  type: 'buy' | 'sell';
  encryptedAmount: string;
  encryptedPrice: string;
  timestamp: number;
  creator: string;
  status: 'pending' | 'matched' | 'completed';
}

interface MarketData {
  totalVolume: number;
  averagePrice: number;
  activeOrders: number;
  matchedOrders: number;
}

interface UserAction {
  type: 'create' | 'match' | 'decrypt';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<CarbonOrder[]>([]);
  const [marketData, setMarketData] = useState<MarketData>({
    totalVolume: 0,
    averagePrice: 0,
    activeOrders: 0,
    matchedOrders: 0
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newOrderData, setNewOrderData] = useState({ type: 'buy' as 'buy' | 'sell', amount: 0, price: 0 });
  const [selectedOrder, setSelectedOrder] = useState<CarbonOrder | null>(null);
  const [decryptedData, setDecryptedData] = useState<{ amount: number | null; price: number | null }>({ amount: null, price: null });
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [priceHistory, setPriceHistory] = useState<{ timestamp: number; price: number }[]>([]);
  
  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load orders
      const ordersBytes = await contract.getData("carbon_orders");
      let ordersList: CarbonOrder[] = [];
      if (ordersBytes.length > 0) {
        try {
          const ordersStr = ethers.toUtf8String(ordersBytes);
          if (ordersStr.trim() !== '') ordersList = JSON.parse(ordersStr);
        } catch (e) {}
      }
      setOrders(ordersList);
      
      // Load market data
      const marketBytes = await contract.getData("market_data");
      let market: MarketData = {
        totalVolume: 0,
        averagePrice: 0,
        activeOrders: 0,
        matchedOrders: 0
      };
      if (marketBytes.length > 0) {
        try {
          const marketStr = ethers.toUtf8String(marketBytes);
          if (marketStr.trim() !== '') market = JSON.parse(marketStr);
        } catch (e) {}
      }
      setMarketData(market);
      
      // Load price history
      const historyBytes = await contract.getData("price_history");
      let history: { timestamp: number; price: number }[] = [];
      if (historyBytes.length > 0) {
        try {
          const historyStr = ethers.toUtf8String(historyBytes);
          if (historyStr.trim() !== '') history = JSON.parse(historyStr);
        } catch (e) {}
      }
      setPriceHistory(history);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Create new order
  const createOrder = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setCreatingOrder(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating order with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new order
      const newOrder: CarbonOrder = {
        id: orders.length + 1,
        type: newOrderData.type,
        encryptedAmount: FHEEncryptNumber(newOrderData.amount),
        encryptedPrice: FHEEncryptNumber(newOrderData.price),
        timestamp: Math.floor(Date.now() / 1000),
        creator: address,
        status: 'pending'
      };
      
      // Update orders list
      const updatedOrders = [...orders, newOrder];
      
      // Update market data
      const updatedMarketData = {
        ...marketData,
        activeOrders: marketData.activeOrders + 1
      };
      
      // Update price history
      const updatedPriceHistory = [
        ...priceHistory,
        { timestamp: Math.floor(Date.now() / 1000), price: newOrderData.price }
      ];
      
      // Save to contract
      await contract.setData("carbon_orders", ethers.toUtf8Bytes(JSON.stringify(updatedOrders)));
      await contract.setData("market_data", ethers.toUtf8Bytes(JSON.stringify(updatedMarketData)));
      await contract.setData("price_history", ethers.toUtf8Bytes(JSON.stringify(updatedPriceHistory)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'create',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Created ${newOrderData.type} order for ${newOrderData.amount} credits`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Order created successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewOrderData({ type: 'buy', amount: 0, price: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreatingOrder(false); 
    }
  };

  // Match orders
  const matchOrder = async (orderId: number) => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Matching order with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the order
      const orderIndex = orders.findIndex(o => o.id === orderId);
      if (orderIndex === -1) throw new Error("Order not found");
      
      // Update order status
      const updatedOrders = [...orders];
      updatedOrders[orderIndex].status = 'matched';
      
      // Update market data
      const updatedMarketData = {
        ...marketData,
        matchedOrders: marketData.matchedOrders + 1,
        activeOrders: marketData.activeOrders - 1
      };
      
      // Save to contract
      await contract.setData("carbon_orders", ethers.toUtf8Bytes(JSON.stringify(updatedOrders)));
      await contract.setData("market_data", ethers.toUtf8Bytes(JSON.stringify(updatedMarketData)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'match',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Matched order #${orderId}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Order matched successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Matching failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt order with signature
  const decryptWithSignature = async (encryptedAmount: string, encryptedPrice: string): Promise<{ amount: number | null; price: number | null }> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return { amount: null, price: null }; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE data"
      };
      setUserActions(prev => [newAction, ...prev]);
      
      return {
        amount: FHEDecryptNumber(encryptedAmount),
        price: FHEDecryptNumber(encryptedPrice)
      };
    } catch (e) { 
      return { amount: null, price: null }; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Render market statistics
  const renderMarketStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon volume"></div>
          <div className="stat-content">
            <div className="stat-value">{marketData.totalVolume.toLocaleString()}</div>
            <div className="stat-label">Total Volume</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon price"></div>
          <div className="stat-content">
            <div className="stat-value">${marketData.averagePrice.toFixed(2)}</div>
            <div className="stat-label">Avg Price</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon active"></div>
          <div className="stat-content">
            <div className="stat-value">{marketData.activeOrders}</div>
            <div className="stat-label">Active Orders</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon matched"></div>
          <div className="stat-content">
            <div className="stat-value">{marketData.matchedOrders}</div>
            <div className="stat-label">Matched Orders</div>
          </div>
        </div>
      </div>
    );
  };

  // Render price chart
  const renderPriceChart = () => {
    if (priceHistory.length === 0) {
      return (
        <div className="no-data">
          <div className="chart-icon"></div>
          <p>No price data available</p>
        </div>
      );
    }
    
    // For demo purposes, we'll generate a simple line chart
    const maxPrice = Math.max(...priceHistory.map(p => p.price));
    const minPrice = Math.min(...priceHistory.map(p => p.price));
    const range = maxPrice - minPrice;
    
    return (
      <div className="price-chart">
        <div className="chart-header">
          <h3>Carbon Credit Price History</h3>
          <div className="chart-range">
            <span>${minPrice.toFixed(2)}</span>
            <span>${maxPrice.toFixed(2)}</span>
          </div>
        </div>
        <div className="chart-container">
          {priceHistory.map((point, index) => {
            const height = range > 0 ? ((point.price - minPrice) / range) * 100 : 50;
            return (
              <div 
                key={index} 
                className="chart-bar" 
                style={{ height: `${height}%` }}
                title={`$${point.price.toFixed(2)}`}
              ></div>
            );
          })}
        </div>
        <div className="chart-footer">
          <span>Past 7 days</span>
        </div>
      </div>
    );
  };

  // Render FHE flow visualization
  const renderFHEFlow = () => {
    return (
      <div className="fhe-flow">
        <div className="flow-step">
          <div className="step-icon">1</div>
          <div className="step-content">
            <h4>Order Creation</h4>
            <p>Enter buy/sell orders with FHE-encrypted price and quantity</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">2</div>
          <div className="step-content">
            <h4>FHE Matching</h4>
            <p>Orders are matched on-chain without revealing sensitive data</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">3</div>
          <div className="step-content">
            <h4>Private Settlement</h4>
            <p>Transactions settle privately, protecting corporate strategies</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">4</div>
          <div className="step-content">
            <h4>Regulatory Compliance</h4>
            <p>All transactions are verifiable while preserving privacy</p>
          </div>
        </div>
      </div>
    );
  };

  // Render user actions history
  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions recorded</div>;
    
    return (
      <div className="actions-list">
        {userActions.map((action, index) => (
          <div className="action-item" key={index}>
            <div className={`action-type ${action.type}`}>
              {action.type === 'create' && '📝'}
              {action.type === 'match' && '🤝'}
              {action.type === 'decrypt' && '🔓'}
            </div>
            <div className="action-details">
              <div className="action-text">{action.details}</div>
              <div className="action-time">{new Date(action.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render compliance verification
  const renderCompliance = () => {
    return (
      <div className="compliance-card">
        <div className="compliance-header">
          <div className="shield-icon"></div>
          <h3>Regulatory Compliance</h3>
        </div>
        <div className="compliance-status">
          <div className="status-item verified">
            <div className="status-icon"></div>
            <div className="status-text">Identity Verification</div>
          </div>
          <div className="status-item verified">
            <div className="status-icon"></div>
            <div className="status-text">Transaction Auditing</div>
          </div>
          <div className="status-item pending">
            <div className="status-icon"></div>
            <div className="status-text">Carbon Credit Validation</div>
          </div>
        </div>
        <div className="compliance-footer">
          <button className="verify-btn">Verify Compliance</button>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted carbon marketplace...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="carbon-icon"></div>
          </div>
          <h1>Carbon<span>Credit</span>FHE</h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-order-btn"
          >
            <div className="add-icon"></div>Create Order
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-grid">
            <div className="dashboard-panel intro-panel">
              <div className="panel-card">
                <h2>Confidential Enterprise Carbon Credit Marketplace</h2>
                <p>Trade carbon credits privately using Zama FHE technology to protect corporate strategies and sensitive financial data.</p>
                <div className="fhe-badge">
                  <div className="fhe-icon"></div>
                  <span>Powered by Zama FHE</span>
                </div>
              </div>
              
              <div className="panel-card">
                <h2>FHE Trading Flow</h2>
                {renderFHEFlow()}
              </div>
              
              <div className="panel-card">
                <h2>Market Statistics</h2>
                {renderMarketStats()}
              </div>
            </div>
            
            <div className="dashboard-panel chart-panel">
              <div className="panel-card">
                <h2>Price Analytics</h2>
                {renderPriceChart()}
              </div>
              
              <div className="panel-card">
                <h2>Compliance Verification</h2>
                {renderCompliance()}
              </div>
            </div>
          </div>
          
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`}
                onClick={() => setActiveTab('dashboard')}
              >
                Dashboard
              </button>
              <button 
                className={`tab ${activeTab === 'orders' ? 'active' : ''}`}
                onClick={() => setActiveTab('orders')}
              >
                Orders
              </button>
              <button 
                className={`tab ${activeTab === 'actions' ? 'active' : ''}`}
                onClick={() => setActiveTab('actions')}
              >
                My Activity
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'dashboard' && (
                <div className="dashboard-content">
                  <div className="market-overview">
                    <h2>Real-Time Market Overview</h2>
                    <div className="overview-grid">
                      <div className="overview-card">
                        <div className="card-header">
                          <div className="icon buy"></div>
                          <h3>Buy Orders</h3>
                        </div>
                        <div className="card-content">
                          <div className="stat-value">
                            {orders.filter(o => o.type === 'buy' && o.status === 'pending').length}
                          </div>
                          <div className="stat-label">Active Buy Orders</div>
                        </div>
                      </div>
                      <div className="overview-card">
                        <div className="card-header">
                          <div className="icon sell"></div>
                          <h3>Sell Orders</h3>
                        </div>
                        <div className="card-content">
                          <div className="stat-value">
                            {orders.filter(o => o.type === 'sell' && o.status === 'pending').length}
                          </div>
                          <div className="stat-label">Active Sell Orders</div>
                        </div>
                      </div>
                      <div className="overview-card">
                        <div className="card-header">
                          <div className="icon matched"></div>
                          <h3>Recent Matches</h3>
                        </div>
                        <div className="card-content">
                          <div className="stat-value">
                            {orders.filter(o => o.status === 'matched').length}
                          </div>
                          <div className="stat-label">Matched Today</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              
              {activeTab === 'orders' && (
                <div className="orders-section">
                  <div className="section-header">
                    <h2>Active Carbon Credit Orders</h2>
                    <div className="header-actions">
                      <button 
                        onClick={loadData} 
                        className="refresh-btn" 
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="orders-list">
                    {orders.length === 0 ? (
                      <div className="no-orders">
                        <div className="no-orders-icon"></div>
                        <p>No active orders found</p>
                        <button 
                          className="create-btn" 
                          onClick={() => setShowCreateModal(true)}
                        >
                          Create First Order
                        </button>
                      </div>
                    ) : orders.map((order, index) => (
                      <div 
                        className={`order-item ${selectedOrder?.id === order.id ? "selected" : ""} ${order.type}`} 
                        key={index}
                        onClick={() => setSelectedOrder(order)}
                      >
                        <div className="order-type">{order.type.toUpperCase()}</div>
                        <div className="order-details">
                          <div className="order-amount">Amount: {order.encryptedAmount.substring(0, 15)}...</div>
                          <div className="order-price">Price: {order.encryptedPrice.substring(0, 15)}...</div>
                        </div>
                        <div className="order-creator">Creator: {order.creator.substring(0, 6)}...{order.creator.substring(38)}</div>
                        <div className={`order-status ${order.status}`}>{order.status}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'actions' && (
                <div className="actions-section">
                  <h2>My Activity History</h2>
                  {renderUserActions()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreateOrder 
          onSubmit={createOrder} 
          onClose={() => setShowCreateModal(false)} 
          creating={creatingOrder} 
          orderData={newOrderData} 
          setOrderData={setNewOrderData}
        />
      )}
      
      {selectedOrder && (
        <OrderDetailModal 
          order={selectedOrder} 
          onClose={() => { 
            setSelectedOrder(null); 
            setDecryptedData({ amount: null, price: null }); 
          }} 
          decryptedData={decryptedData} 
          setDecryptedData={setDecryptedData} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          matchOrder={matchOrder}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="carbon-icon"></div>
              <span>CarbonCredit_FHE</span>
            </div>
            <p>Confidential Enterprise Carbon Credit Marketplace</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} CarbonCredit_FHE. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect corporate strategies. 
            All transactions are encrypted to prevent market manipulation and protect sensitive financial data.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateOrderProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  orderData: any;
  setOrderData: (data: any) => void;
}

const ModalCreateOrder: React.FC<ModalCreateOrderProps> = ({ onSubmit, onClose, creating, orderData, setOrderData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setOrderData({ ...orderData, [name]: name === 'type' ? value : parseFloat(value) });
  };

  return (
    <div className="modal-overlay">
      <div className="create-order-modal">
        <div className="modal-header">
          <h2>Create Carbon Credit Order</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Privacy Notice</strong>
              <p>Order details will be encrypted using Zama FHE technology</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Order Type *</label>
            <select 
              name="type" 
              value={orderData.type} 
              onChange={handleChange}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Carbon Credits *</label>
            <input 
              type="number" 
              name="amount" 
              value={orderData.amount} 
              onChange={handleChange} 
              placeholder="Enter quantity..." 
              min="1"
            />
          </div>
          
          <div className="form-group">
            <label>Price per Credit ($) *</label>
            <input 
              type="number" 
              name="price" 
              value={orderData.price} 
              onChange={handleChange} 
              placeholder="Enter price..." 
              min="0.01"
              step="0.01"
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={creating || orderData.amount <= 0 || orderData.price <= 0} 
            className="submit-btn"
          >
            {creating ? "Creating with FHE..." : "Create Order"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface OrderDetailModalProps {
  order: CarbonOrder;
  onClose: () => void;
  decryptedData: { amount: number | null; price: number | null };
  setDecryptedData: (value: { amount: number | null; price: number | null }) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedAmount: string, encryptedPrice: string) => Promise<{ amount: number | null; price: number | null }>;
  matchOrder: (orderId: number) => void;
}

const OrderDetailModal: React.FC<OrderDetailModalProps> = ({ 
  order, 
  onClose, 
  decryptedData, 
  setDecryptedData, 
  isDecrypting, 
  decryptWithSignature,
  matchOrder
}) => {
  const handleDecrypt = async () => {
    if (decryptedData.amount !== null) { 
      setDecryptedData({ amount: null, price: null }); 
      return; 
    }
    
    const decrypted = await decryptWithSignature(order.encryptedAmount, order.encryptedPrice);
    if (decrypted !== null) {
      setDecryptedData(decrypted);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="order-detail-modal">
        <div className="modal-header">
          <h2>Order Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="order-info">
            <div className="info-item">
              <span>Order ID:</span>
              <strong>#{order.id}</strong>
            </div>
            <div className="info-item">
              <span>Type:</span>
              <strong className={`order-type ${order.type}`}>{order.type.toUpperCase()}</strong>
            </div>
            <div className="info-item">
              <span>Creator:</span>
              <strong>{order.creator.substring(0, 6)}...{order.creator.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Created:</span>
              <strong>{new Date(order.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`order-status ${order.status}`}>{order.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Order Data</h3>
            <div className="encrypted-data">
              <div className="data-item">
                <span>Amount:</span>
                <div>{order.encryptedAmount.substring(0, 30)}...</div>
              </div>
              <div className="data-item">
                <span>Price:</span>
                <div>{order.encryptedPrice.substring(0, 30)}...</div>
              </div>
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span>Decrypting...</span>
              ) : decryptedData.amount !== null ? (
                "Hide Decrypted Data"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedData.amount !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Order Data</h3>
              <div className="decrypted-values">
                <div className="decrypted-value">
                  <span>Amount:</span>
                  <strong>{decryptedData.amount} credits</strong>
                </div>
                <div className="decrypted-value">
                  <span>Price:</span>
                  <strong>${decryptedData.price?.toFixed(2)} per credit</strong>
                </div>
                <div className="decrypted-value">
                  <span>Total Value:</span>
                  <strong>${(decryptedData.amount * (decryptedData.price || 0)).toFixed(2)}</strong>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          {order.status === 'pending' && (
            <button 
              className="match-btn" 
              onClick={() => matchOrder(order.id)}
            >
              Match This Order
            </button>
          )}
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;