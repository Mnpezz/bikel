import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, useMap } from 'react-leaflet';
import { Bike, Activity, CalendarPlus, Zap, LogIn, Info, HelpCircle, Smartphone, X, Clock, Route, CheckCircle, RefreshCw, Map as MapIcon } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { connectNDK, fetchRecentRides, fetchUserRides, fetchScheduledRides, loginNip07, publishRSVP, connectNWC, zapRideEvent, fetchComments, publishComment, fetchDMs, sendDM } from './lib/nostr';
import type { RideEvent, ScheduledRideEvent, RideComment, DMessage } from './lib/nostr';
import type { NDKUser } from '@nostr-dev-kit/ndk';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [rides, setRides] = useState<RideEvent[]>([]);
  const [myRides, setMyRides] = useState<RideEvent[]>([]);
  const [authorRides, setAuthorRides] = useState<RideEvent[]>([]);
  const [scheduledRides, setScheduledRides] = useState<ScheduledRideEvent[]>([]);
  const [user, setUser] = useState<NDKUser | null>(null);
  const [selectedRide, setSelectedRide] = useState<RideEvent | null>(null);
  const [viewingAuthor, setViewingAuthor] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'global' | 'personal' | 'scheduled' | 'author'>('global');

  // Lightning Wallet states
  const [showNWCModal, setShowNWCModal] = useState(false);
  const [nwcURI, setNwcURI] = useState('');
  const [isNWCConnected, setIsNWCConnected] = useState(false);
  const [zappingEventId, setZappingEventId] = useState<string | null>(null);

  // Side Panel states
  const [showAbout, setShowAbout] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);
  const [showAppPromo, setShowAppPromo] = useState(false);

  // Comments states
  const [comments, setComments] = useState<RideComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isPublishingComment, setIsPublishingComment] = useState(false);

  // DM states
  const [activeDMUser, setActiveDMUser] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DMessage[]>([]);
  const [newDMText, setNewDMText] = useState('');
  const [isSendingDM, setIsSendingDM] = useState(false);

  // Fetch DMs when discussion is triggered
  useEffect(() => {
    if (activeDMUser) {
      setDmMessages([]);
      fetchDMs(activeDMUser).then(setDmMessages);
    }
  }, [activeDMUser]);

  const loadFeeds = async () => {
    try {
      const fetchedRides = await fetchRecentRides();
      setRides(fetchedRides);
      const fetchedScheduled = await fetchScheduledRides();
      setScheduledRides(fetchedScheduled);
      if (user) {
        const personalRides = await fetchUserRides(user.pubkey);
        setMyRides(personalRides);
      }
      if (viewMode === 'author' && viewingAuthor) {
        const authoredRides = await fetchUserRides(viewingAuthor);
        setAuthorRides(authoredRides);
      }
    } catch (e) {
      console.error("Failed to load feeds:", e);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      // Connect to relays
      await connectNDK();
      if (mounted) setIsConnected(true);

      const savedNwc = localStorage.getItem('bikel_nwc_uri');
      if (savedNwc) {
        setNwcURI(savedNwc);
        const success = await connectNWC(savedNwc);
        if (mounted && success) setIsNWCConnected(true);
      }

      await loadFeeds();
    })();
    return () => { mounted = false; };
  }, [user]); // Re-run when user authenticates to grab personal feeds

  // Fetch comments when a ride is selected
  useEffect(() => {
    if (selectedRide) {
      setComments([]);
      fetchComments(selectedRide.id).then(setComments);
    }
  }, [selectedRide]);

  const handleLogin = async () => {
    const nip07user = await loginNip07();
    if (nip07user) {
      setUser(nip07user);
      const personalRides = await fetchUserRides(nip07user.pubkey);
      setMyRides(personalRides);
      setViewMode('personal');
    }
  };

  const toggleViewMode = () => {
    setViewMode(prev => prev === 'global' ? 'personal' : 'global');
  };

  const loadAuthorProfile = async (npub: string) => {
    setSelectedRide(null); // Close modal
    setViewingAuthor(npub);
    setViewMode('author');
    setAuthorRides([]); // Clear old while fetching

    // Fetch this user's rides natively! Our nostr.ts util handles npubs automatically
    const ridesForAuthor = await fetchUserRides(npub);
    setAuthorRides(ridesForAuthor);
  };

  const handleRSVP = async (ride: ScheduledRideEvent) => {
    if (!user) return;
    const success = await publishRSVP(ride);
    if (success) {
      // Optimistically update local state
      setScheduledRides(prev => prev.map(r =>
        r.id === ride.id
          ? { ...r, attendees: [...r.attendees, user.pubkey] }
          : r
      ));
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header animate-fade-in">
        <div className="logo">
          <Bike size={28} color="var(--accent-primary)" strokeWidth={2.5} />
          Bikel<span>.</span>
        </div>

        <div className="relay-status">
          <div className={`status-indicator ${isConnected ? 'connected' : ''}`}></div>
          {isConnected ? 'Connected to Relays' : 'Connecting...'}
        </div>

        <div className="header-actions">
          <button
            className="btn btn-surface"
            style={{ padding: '8px', color: viewMode === 'global' ? '#00ffaa' : '#555' }}
            onClick={() => setViewMode('global')}
            title="View Recent Rides"
          >
            <Activity size={20} />
          </button>
          <button
            className="btn btn-surface"
            style={{ padding: '8px', color: viewMode === 'scheduled' ? '#00ffaa' : '#555' }}
            onClick={() => setViewMode('scheduled')}
            title="View Upcoming Group Rides"
          >
            <CalendarPlus size={20} />
          </button>

          <button
            className="btn btn-surface"
            style={{ padding: '8px', color: isNWCConnected ? '#eab308' : '#555' }}
            onClick={() => setShowNWCModal(true)}
            title="Connect Lightning Wallet"
          >
            <Zap size={20} />
          </button>

          <button
            className="btn btn-surface"
            style={{ padding: '8px', color: '#555' }}
            onClick={() => setShowAbout(true)}
            title="About Bikel"
          >
            <Info size={20} />
          </button>

          <button
            className="btn btn-surface"
            style={{ padding: '8px', color: '#555' }}
            onClick={() => setShowHowTo(true)}
            title="How to Use Bikel"
          >
            <HelpCircle size={20} />
          </button>

          <button
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }}
            onClick={() => setShowAppPromo(true)}
          >
            <Smartphone size={16} /> Get App
          </button>
          {user ? (
            <div
              className="user-profile"
              style={{ display: 'flex', alignItems: 'center', gap: '8px', color: viewMode === 'personal' ? '#00ffaa' : '#fff', cursor: 'pointer', padding: '6px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: '20px' }}
              onClick={toggleViewMode}
            >
              <div className="avatar-mini" style={{ width: '28px', height: '28px', background: viewMode === 'personal' ? '#00ffaa' : '#fff' }}></div>
              <span>{user.profile?.name || user.pubkey.substring(0, 8)}</span>
            </div>
          ) : (
            <button className="btn btn-primary" style={{ color: '#000', display: 'flex', alignItems: 'center', gap: '6px' }} onClick={handleLogin}>
              <LogIn size={16} /> Sign In
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Sidebar */}
        <aside className="sidebar">

          <div className="widget glass-panel animate-fade-in" style={{ animationDelay: '0.1s' }}>
            <h2 className="widget-title"><Zap size={16} /> Global Stats (24h)</h2>
            <div className="global-stats">
              <div className="stat-box">
                <div className="stat-value">
                  {rides.reduce((acc, r) => acc + parseFloat(r.distance || '0'), 0).toFixed(1)}
                </div>
                <div className="stat-label">Miles Ridden</div>
              </div>
              <div className="stat-box">
                <div className="stat-value">{new Set(rides.map(r => r.pubkey)).size}</div>
                <div className="stat-label">Active Riders</div>
              </div>
            </div>
          </div>

          <div className="widget glass-panel animate-fade-in" style={{ flex: 1, animationDelay: '0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 className="widget-title" style={{ margin: 0 }}>
                  {viewMode === 'scheduled' ? <><CalendarPlus size={16} /> Upcoming Group Rides</> :
                    viewMode === 'author' ? <><Activity size={16} /> Rides by {viewingAuthor?.substring(0, 10)}...</> :
                      <><Activity size={16} /> {viewMode === 'personal' ? 'My Recent Rides' : 'Recent Public Rides'}</>}
                </h2>
                <button
                  className="btn btn-surface"
                  style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => loadFeeds()}
                  title="Refresh Feeds"
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              {viewMode === 'author' && user && viewingAuthor !== user.pubkey && (
                <button
                  className="btn btn-primary"
                  style={{ padding: '6px 12px', fontSize: '13px', background: '#00ccff', color: '#000', fontWeight: 'bold' }}
                  onClick={() => setActiveDMUser(viewingAuthor)}
                >
                  Message
                </button>
              )}
            </div>
            <div className="ride-feed">
              {viewMode === 'global' && rides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>No public rides found. Be the first!</div>}
              {viewMode === 'personal' && myRides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>You haven't recorded any rides yet.</div>}
              {viewMode === 'scheduled' && scheduledRides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>No upcoming group rides scheduled right now.</div>}
              {viewMode === 'author' && authorRides.length === 0 && <div className="ride-stat" style={{ padding: '12px' }}>Loading author rides...</div>}

              {viewMode === 'scheduled' ? scheduledRides.map((event) => (
                <div className="ride-card" key={event.id} style={{ cursor: 'default' }}>
                  <img src={event.image || '/bikelLogo.jpg'} alt="Ride Map" style={{ width: '100%', height: '120px', objectFit: 'cover', borderRadius: '8px', marginBottom: '12px' }} />
                  <div className="ride-header">
                    <div style={{ fontWeight: 'bold', color: '#00ffaa' }}>{event.name}</div>
                  </div>
                  <div style={{ fontSize: '12px', color: '#aaa', marginTop: '4px', marginBottom: '8px' }}>
                    {format(new Date(event.startTime * 1000), "EEEE, MMM d 'at' h:mm a")}
                    {event.timezone ? ` (${event.timezone})` : ""}
                  </div>
                  <div style={{ fontSize: '13px', marginBottom: '12px', lineHeight: 1.4 }}>
                    {event.description}
                  </div>
                  <div className="ride-stats" style={{ justifyContent: 'space-between' }}>
                    <div className="stat-item" style={{ flex: 1, color: '#888' }}>
                      📍 {event.locationStr}
                      {event.attendees && event.attendees.length > 0 && (
                        <span style={{ marginLeft: '12px', color: '#00ffaa' }}>
                          👤 {event.attendees.length} attending
                        </span>
                      )}
                    </div>
                    {user && (
                      <button
                        className="btn btn-surface"
                        style={{
                          padding: '4px 12px',
                          fontSize: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          background: event.attendees && event.attendees.includes(user.pubkey) ? 'rgba(0, 255, 170, 0.1)' : undefined,
                          color: event.attendees && event.attendees.includes(user.pubkey) ? '#00ffaa' : undefined,
                          borderColor: event.attendees && event.attendees.includes(user.pubkey) ? '#00ffaa' : undefined
                        }}
                        onClick={(e) => { e.stopPropagation(); handleRSVP(event); }}
                        disabled={event.attendees && event.attendees.includes(user.pubkey)}
                      >
                        <CheckCircle size={14} /> {event.attendees && event.attendees.includes(user.pubkey) ? 'Attending' : 'RSVP'}
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span>
                        Org: <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={(e) => { e.stopPropagation(); loadAuthorProfile(event.pubkey); }}>{event.pubkey.substring(0, 10)}...</span>
                      </span>
                      {event.route && event.route.length > 0 && (
                        <button
                          className="btn btn-surface"
                          style={{ padding: '2px 8px', fontSize: '11px', background: 'rgba(0, 255, 170, 0.1)', color: '#00ffaa' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Convert back to RideEvent format just to reuse the existing setSelectedRide overlay easily
                            setSelectedRide({
                              id: event.id,
                              pubkey: event.pubkey,
                              hexPubkey: event.hexPubkey,
                              time: event.startTime,
                              distance: 'GPS Route',
                              duration: 'Scheduled',
                              visibility: 'full',
                              route: event.route!,
                              kind: 33301
                            });
                          }}
                        >
                          🗺️ Map
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                      {isNWCConnected && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (zappingEventId) return;
                            setZappingEventId(event.id);
                            try {
                              await zapRideEvent(event.id, event.hexPubkey, event.kind, 21, "Thanks for organizing this ride!"); // 21 sats
                              alert("Successfully sent 21 sats!");
                            } catch (e: any) {
                              alert("Zap failed: " + (e.message || "Unknown error"));
                            }
                            setZappingEventId(null);
                          }}
                          style={{ background: 'none', border: 'none', color: '#eab308', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}
                          title="Zap Organizer 21 Sats"
                        >
                          <Zap size={14} fill={zappingEventId === event.id ? "#eab308" : "none"} /> 21
                        </button>
                      )}
                      <a href={`nostr:${event.pubkey}`} onClick={(e) => e.stopPropagation()} style={{ color: '#00ccff', textDecoration: 'underline' }}>
                        Message Organizer
                      </a>
                    </div>
                  </div>
                </div>
              )) : (viewMode === 'personal' ? myRides : viewMode === 'author' ? authorRides : rides).map((ride) => (
                <div className="ride-card" key={ride.id} onClick={() => setSelectedRide(ride)}>
                  <img src={ride.image || '/bikelLogo.jpg'} alt="Ride Map" style={{ width: '100%', height: '120px', objectFit: 'cover', borderRadius: '8px', marginBottom: '12px' }} />
                  <div className="ride-header">
                    <div className="ride-pubkey" title={ride.pubkey}>
                      <div className="avatar-mini"></div>
                      <span onClick={(e) => { e.stopPropagation(); loadAuthorProfile(ride.pubkey); }} style={{ cursor: 'pointer' }}>
                        {ride.pubkey.substring(0, 10)}...
                      </span>
                    </div>
                    <div className="ride-time">{formatDistanceToNow(ride.time * 1000, { addSuffix: true })}</div>
                  </div>
                  <div className="ride-stats">
                    <div className="stat-item">
                      <Route size={14} className="icon" /> {ride.distance} mi
                    </div>
                    <div className="stat-item">
                      <Clock size={14} className="icon" /> {ride.duration}
                    </div>
                    {isNWCConnected && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (zappingEventId) return;
                          setZappingEventId(ride.id);
                          try {
                            await zapRideEvent(ride.id, ride.hexPubkey, ride.kind, 21, "Great ride!");
                            alert("Successfully sent 21 sats!");
                          } catch (e: any) {
                            alert("Zap failed: " + (e.message || "Unknown error"));
                          }
                          setZappingEventId(null);
                        }}
                        className="stat-item"
                        style={{ background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', color: '#eab308', marginLeft: 'auto', borderRadius: '12px', padding: '2px 8px', cursor: 'pointer' }}
                        title="Zap Rider 21 Sats"
                      >
                        <Zap size={12} fill={zappingEventId === ride.id ? "#eab308" : "none"} /> 21
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Map View */}
        <section className="map-wrapper animate-fade-in" style={{ animationDelay: '0.3s' }}>
          <MapContainer center={[51.505, -0.09]} zoom={13} scrollWheelZoom={true} zoomControl={false}>
            {/* Dark Mode Tiles - CartoDB Dark Matter */}
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {(viewMode === 'personal' ? myRides : rides).map(ride => {
              if (ride.route.length === 0) return null;

              const startCoords: [number, number] = [ride.route[0][0], ride.route[0][1]];

              return (
                <div key={ride.id}>
                  <CircleMarker
                    center={startCoords}
                    radius={6}
                    pathOptions={{
                      color: 'var(--accent-primary)',
                      fillColor: 'var(--accent-primary)',
                      fillOpacity: 0.8,
                      weight: 2
                    }}
                    eventHandlers={{
                      click: () => setSelectedRide(ride)
                    }}
                  >
                    <Popup>
                      <div style={{ color: '#000', fontSize: '13px' }}>
                        <strong>{ride.pubkey.substring(0, 12)}...</strong><br />
                        {ride.distance} mi in {ride.duration}
                      </div>
                    </Popup>
                  </CircleMarker>
                  <Polyline
                    positions={ride.route as [number, number][]}
                    pathOptions={{ color: 'var(--accent-primary)', weight: 3, opacity: 0.6 }}
                    eventHandlers={{
                      click: () => setSelectedRide(ride)
                    }}
                  />
                </div>
              );
            })}
          </MapContainer>
        </section>
      </main>

      {/* Ride Detail Modal */}
      {
        selectedRide && (
          <div className="modal-overlay">
            <div className="modal-content animate-fade-in glass-panel" style={{ width: '80%', maxWidth: '900px', height: '80vh', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                <div>
                  <h2 style={{ margin: 0, color: '#00ffaa' }}>Ride Details</h2>
                  <div style={{ color: '#888', fontSize: '14px', marginTop: '4px' }}>
                    {formatDistanceToNow(selectedRide.time * 1000, { addSuffix: true })} by
                    <span
                      style={{ color: '#00ffaa', cursor: 'pointer', marginLeft: '4px', textDecoration: 'underline' }}
                      onClick={() => loadAuthorProfile(selectedRide.pubkey)}
                    >
                      {selectedRide.pubkey.substring(0, 16)}...
                    </span>
                  </div>
                </div>
                <button onClick={() => setSelectedRide(null)} className="btn btn-surface" style={{ padding: '8px' }}>
                  <X size={24} />
                </button>
              </div>

              <div className="modal-stats" style={{ display: 'flex', padding: '20px', gap: '40px', background: 'rgba(0,0,0,0.3)' }}>
                <div className="stat-box">
                  <div className="stat-value">{selectedRide.distance}</div>
                  <div className="stat-label">MILES</div>
                </div>
                <div className="stat-box">
                  <div className="stat-value">{selectedRide.duration}</div>
                  <div className="stat-label">TIME</div>
                </div>
              </div>

              <div className="modal-map" style={{ flex: 1, position: 'relative' }}>
                {selectedRide.route.length > 0 ? (
                  <MapContainer
                    center={[selectedRide.route[0][0], selectedRide.route[0][1]]}
                    zoom={14}
                    style={{ height: '100%', width: '100%' }}
                  >
                    <TileLayer
                      url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    />
                    <Polyline
                      positions={selectedRide.route as [number, number][]}
                      pathOptions={{ color: '#00ffaa', weight: 4, opacity: 0.8 }}
                    />
                    <CircleMarker center={[selectedRide.route[0][0], selectedRide.route[0][1]]} radius={6} pathOptions={{ color: '#00ffaa', fillOpacity: 1 }} />
                    <CircleMarker center={[selectedRide.route[selectedRide.route.length - 1][0], selectedRide.route[selectedRide.route.length - 1][1]]} radius={6} pathOptions={{ color: '#ff4d4f', fillOpacity: 1 }} />
                    <SetMapBounds route={selectedRide.route} />
                  </MapContainer>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>
                    No route data published for this ride.
                  </div>
                )}
              </div>

              <div className="modal-comments" style={{ padding: '20px', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <h3 style={{ margin: '0 0 16px', color: '#fff', fontSize: '16px' }}>Discussion</h3>
                <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '8px' }}>
                  {comments.length === 0 ? (
                    <div style={{ color: '#666', fontSize: '14px', fontStyle: 'italic' }}>No comments yet. Be the first!</div>
                  ) : (
                    comments.map(c => (
                      <div key={c.id} style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ color: '#00ffaa', fontSize: '12px', fontWeight: 'bold' }}>{c.pubkey.substring(0, 10)}...</span>
                          <span style={{ color: '#888', fontSize: '12px' }}>{formatDistanceToNow(c.createdAt * 1000, { addSuffix: true })}</span>
                        </div>
                        <div style={{ color: '#eee', fontSize: '14px', lineHeight: '1.4' }}>{c.content}</div>
                      </div>
                    ))
                  )}
                </div>
                {user ? (
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <input
                      type="text"
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Write a comment..."
                      disabled={isPublishingComment}
                      style={{ flex: 1, padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && !isPublishingComment && newComment.trim() && selectedRide) {
                          setIsPublishingComment(true);
                          const success = await publishComment(selectedRide.id, newComment.trim());
                          if (success) {
                            setNewComment('');
                            fetchComments(selectedRide.id).then(setComments);
                          } else {
                            alert("Failed to publish comment.");
                          }
                          setIsPublishingComment(false);
                        }
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={isPublishingComment || !newComment.trim()}
                      onClick={async () => {
                        if (!newComment.trim() || !selectedRide) return;
                        setIsPublishingComment(true);
                        const success = await publishComment(selectedRide.id, newComment.trim());
                        if (success) {
                          setNewComment('');
                          fetchComments(selectedRide.id).then(setComments);
                        } else {
                          alert("Failed to publish comment.");
                        }
                        setIsPublishingComment(false);
                      }}
                    >
                      {isPublishingComment ? 'Posting...' : 'Post'}
                    </button>
                  </div>
                ) : (
                  <div style={{ color: '#888', fontSize: '14px' }}>Sign in to connect wallet or see balance.</div>
                )}
              </div>
            </div>
          </div>
        )
      }

      {/* Direct Messaging Overlay */}
      {
        activeDMUser && (
          <div className="modal-overlay">
            <div className="modal-content animate-fade-in glass-panel" style={{ width: '90%', maxWidth: '500px', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                <h2 style={{ margin: 0, color: '#00ccff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Chat with {activeDMUser.substring(0, 8)}...
                </h2>
                <button onClick={() => setActiveDMUser(null)} className="btn btn-surface" style={{ padding: '8px' }}>
                  <X size={24} />
                </button>
              </div>

              <div className="modal-comments" style={{ padding: '20px', background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ height: '300px', overflowY: 'auto', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '8px' }}>
                  {dmMessages.length === 0 ? (
                    <div style={{ color: '#666', fontSize: '14px', fontStyle: 'italic', textAlign: 'center', marginTop: '20px' }}>No messages found. Say Hello!</div>
                  ) : (
                    dmMessages.map(msg => {
                      const isMe = msg.sender === user?.pubkey;
                      return (
                        <div key={msg.id} style={{
                          maxWidth: '80%',
                          alignSelf: isMe ? 'flex-end' : 'flex-start',
                          background: isMe ? 'rgba(0, 204, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                          padding: '12px',
                          borderRadius: '12px',
                          borderBottomRightRadius: isMe ? '2px' : '12px',
                          borderBottomLeftRadius: isMe ? '12px' : '2px',
                        }}>
                          <div style={{ color: '#fff', fontSize: '14px', lineHeight: '1.4' }}>{msg.text}</div>
                          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '10px', marginTop: '4px', textAlign: isMe ? 'right' : 'left' }}>
                            {formatDistanceToNow(msg.createdAt * 1000, { addSuffix: true })}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={newDMText}
                    onChange={(e) => setNewDMText(e.target.value)}
                    placeholder="Type a message..."
                    disabled={isSendingDM}
                    style={{ flex: 1, padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && !isSendingDM && newDMText.trim()) {
                        setIsSendingDM(true);
                        const success = await sendDM(activeDMUser, newDMText.trim());
                        if (success) {
                          setNewDMText('');
                          fetchDMs(activeDMUser).then(setDmMessages);
                        } else {
                          alert("Failed to send message. Make sure your NIP-07 extension supports NIP-04 encryption.");
                        }
                        setIsSendingDM(false);
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ background: '#00ccff', color: '#000', fontWeight: 'bold' }}
                    disabled={isSendingDM || !newDMText.trim()}
                    onClick={async () => {
                      if (!newDMText.trim()) return;
                      setIsSendingDM(true);
                      const success = await sendDM(activeDMUser, newDMText.trim());
                      if (success) {
                        setNewDMText('');
                        fetchDMs(activeDMUser).then(setDmMessages);
                      } else {
                        alert("Failed to send message.");
                      }
                      setIsSendingDM(false);
                    }}
                  >
                    SEND
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }
      {/* NWC Settings Modal */}
      {
        showNWCModal && (
          <div className="modal-overlay">
            <div className="modal-content animate-fade-in glass-panel" style={{ width: '90%', maxWidth: '500px', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                <h2 style={{ margin: 0, color: '#eab308', display: 'flex', alignItems: 'center', gap: '8px' }}><Zap size={24} /> Wallet Connect</h2>
                <button onClick={() => setShowNWCModal(false)} className="btn btn-surface" style={{ padding: '8px' }}>
                  <X size={24} />
                </button>
              </div>
              <div style={{ padding: '20px' }}>
                <p style={{ color: '#ccc', marginBottom: '16px', lineHeight: 1.5 }}>
                  Connect your Lightning Wallet using <strong>NWC (NIP-47)</strong> to instantly send Zaps to ride organizers and fellow cyclists. Give it a try with Alby or Mutiny Wallet!
                </p>
                <input
                  type="password"
                  placeholder="nostr+walletconnect://..."
                  value={nwcURI}
                  onChange={(e) => setNwcURI(e.target.value)}
                  style={{ width: '100%', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', marginBottom: '16px' }}
                />
                <button
                  className="btn btn-primary"
                  style={{ width: '100%', background: '#eab308', color: '#000', fontWeight: 'bold' }}
                  onClick={async () => {
                    if (!nwcURI) return;
                    const success = await connectNWC(nwcURI);
                    if (success) {
                      localStorage.setItem('bikel_nwc_uri', nwcURI);
                      setIsNWCConnected(true);
                      setShowNWCModal(false);
                      // alert("Lightning Wallet connected successfully!"); // Removed to be less disruptive
                    } else {
                      alert("Failed to connect wallet. Check the URI and try again.");
                    }
                  }}
                >
                  Connect Wallet
                </button>
                {isNWCConnected && (
                  <button
                    className="btn btn-surface"
                    style={{ width: '100%', marginTop: '12px', color: '#ff4d4f' }}
                    onClick={() => {
                      localStorage.removeItem('bikel_nwc_uri');
                      setNwcURI('');
                      setIsNWCConnected(false);
                      setShowNWCModal(false);
                    }}
                  >
                    Disconnect Wallet
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      }

      {/* About Panel */}
      <div className={`side-panel ${showAbout ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h2 className="side-panel-title"><Info size={24} color="#00ffaa" /> About Bikel</h2>
          <button className="close-panel-btn" onClick={() => setShowAbout(false)}>
            <X size={20} />
          </button>
        </div>
        <div style={{ color: '#ccc', lineHeight: 1.6 }}>
          <p style={{ marginBottom: '16px' }}>
            <strong style={{ color: '#fff' }}>Bikel</strong> is an open, decentralized mapping application built specifically for cyclists utilizing the Nostr network.
          </p>
          <p style={{ marginBottom: '16px' }}>
            Traditional fitness trackers lock your geolocation data into proprietary silos, monetizing your hardware investments against you. Bikel operates via NIP-52 Time-Based Events natively on Nostr, meaning your global ride histories are permanently secured by cryptographic keys you control.
          </p>
          <p style={{ marginBottom: '16px' }}>
            Organize alleycat races, split micropayments over Lightning (NWC), and maintain a truly sovereign, immutable record of every mile ridden.
          </p>
          <div style={{ padding: '16px', background: 'rgba(0,255,170,0.1)', border: '1px solid rgba(0,255,170,0.3)', borderRadius: '8px', marginTop: '24px' }}>
            <h3 style={{ color: '#00ffaa', fontSize: '16px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={16} /> Open Source
            </h3>
            <p style={{ fontSize: '14px', margin: 0 }}>
              Bikel is entirely open-source software. You are free to audit, clone, and host your own instances of these clients forever.
            </p>
          </div>
        </div>
      </div>

      {/* How To Panel */}
      <div className={`side-panel ${showHowTo ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h2 className="side-panel-title"><HelpCircle size={24} color="#00ffaa" /> How It Works</h2>
          <button className="close-panel-btn" onClick={() => setShowHowTo(false)}>
            <X size={20} />
          </button>
        </div>
        <div style={{ color: '#ccc', lineHeight: 1.6 }}>
          <h3 style={{ color: '#fff', fontSize: '18px', marginBottom: '12px', marginTop: '16px' }}>1. Get a Nostr Key</h3>
          <p style={{ marginBottom: '24px' }}>
            To start posting your rides, you'll need a Nostr extension like nos2x or Alby to manage your cryptographic signature. Click "Sign In" at the top right, and Bikel will automatically locate your NIP-07 web extension!
          </p>

          <h3 style={{ color: '#fff', fontSize: '18px', marginBottom: '12px' }}>2. Record Your Rides</h3>
          <p style={{ marginBottom: '24px' }}>
            While you can view the global web feed here, recording rides happens purely inside the Bikel Mobile App (available on Android). The app acts as an offline-first GPS tracker before compressing your routes into mathematical geometries.
          </p>

          <h3 style={{ color: '#fff', fontSize: '18px', marginBottom: '12px' }}>3. Interact & Zap</h3>
          <p style={{ marginBottom: '24px' }}>
            Click on any ride on the map to view detailed statistical splits, leave comments, or send entirely fee-less Bitcoin micro-payments (Zaps) to riders you support by binding any NWC-compatible lightning wallet!
          </p>
        </div>
      </div>

      {/* App Promo Panel */}
      <div className={`side-panel ${showAppPromo ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h2 className="side-panel-title"><Smartphone size={24} color="#00ffaa" /> Get Bikel Mobile</h2>
          <button className="close-panel-btn" onClick={() => setShowAppPromo(false)}>
            <X size={20} />
          </button>
        </div>
        <div style={{ color: '#ccc', lineHeight: 1.6, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

          <div style={{ width: '100%', aspectRatio: '1', background: 'linear-gradient(135deg, rgba(0,255,170,0.2) 0%, rgba(0,0,0,0.8) 100%)', borderRadius: '16px', border: '1px solid rgba(0,255,170,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', overflow: 'hidden', position: 'relative' }}>
            <MapIcon size={120} color="rgba(0,255,170,0.3)" style={{ position: 'absolute', opacity: 0.5 }} />
            <div style={{ zIndex: 10, textAlign: 'center', background: 'rgba(0,0,0,0.6)', padding: '16px 24px', borderRadius: '30px', backdropFilter: 'blur(5px)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <Bike size={32} color="#00ffaa" style={{ margin: '0 auto 8px auto' }} />
              <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '18px' }}>Tracking Live</div>
              <div style={{ color: '#00ffaa', fontFamily: 'monospace' }}>12.4 mi • 1:04:22</div>
            </div>
          </div>

          <p style={{ textAlign: 'center', fontSize: '16px', marginBottom: '32px' }}>
            Download the official Android APK to passively record maps, upload photos, trim privacy settings, and broadcast rides securely to any Nostr relay of your choosing!
          </p>

          <a
            href="https://github.com/Mnpezz/bikel/releases/download/v1.0.0/app-release.apk"
            download
            className="btn btn-primary"
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '18px',
              justifyContent: 'center',
              background: '#00ffaa',
              color: '#000',
              fontWeight: '900',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              boxShadow: '0 0 20px rgba(0,255,170,0.4)'
            }}
          >
            Download Android APK
          </a>

          <div style={{ marginTop: '24px', fontSize: '12px', color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
            Requires Android 10.0 or higher. Enable "Install Unknown Apps" in settings to sideload the release directly to your device.
          </div>
        </div>
      </div>

    </div >
  );
}

// Helper to center the modal map on the specific ride
function SetMapBounds({ route }: { route: number[][] }) {
  const map = useMap();
  useEffect(() => {
    if (route.length > 0) {
      const bounds = route.map(p => [p[0], p[1]] as [number, number]);
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [route, map]);
  return null;
}

export default App;
