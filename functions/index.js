const { initializeApp } = require('firebase-admin/app');
initializeApp();

const messenger = require('./src/messenger');

module.exports = {
  messengerGetSession: messenger.messengerGetSession,
  messengerEnsureRoom: messenger.messengerEnsureRoom,
  messengerAutoCreateVerifiedStreamerRoom: messenger.messengerAutoCreateVerifiedStreamerRoom,
  messengerAdminBackfillVerifiedRooms: messenger.messengerAdminBackfillVerifiedRooms,
  messengerGetRoomState: messenger.messengerGetRoomState,
  messengerListMyRooms: messenger.messengerListMyRooms,
  messengerUpdateRoom: messenger.messengerUpdateRoom,
  messengerDiscardRoom: messenger.messengerDiscardRoom,
  messengerListApplications: messenger.messengerListApplications,
  messengerListFans: messenger.messengerListFans,
  messengerApplyToRoom: messenger.messengerApplyToRoom,
  messengerReviewApplication: messenger.messengerReviewApplication,
  messengerSetMemberStatus: messenger.messengerSetMemberStatus,
  messengerRoomMarketUpdate: messenger.messengerRoomMarketUpdate,
  messengerSetPinnedMessage: messenger.messengerSetPinnedMessage,
  messengerMiniGameUpdate: messenger.messengerMiniGameUpdate,
  messengerSendMessage: messenger.messengerSendMessage,
  messengerGetLinkPreview: messenger.messengerGetLinkPreview,
  messengerGetGalleryImages: messenger.messengerGetGalleryImages,
  messengerGetGalleryImage: messenger.messengerGetGalleryImage,
  messengerRequestRoomselfUpload: messenger.messengerRequestRoomselfUpload,
  messengerFinalizeRoomselfUpload: messenger.messengerFinalizeRoomselfUpload,
  messengerGetRoomselfImage: messenger.messengerGetRoomselfImage,
  messengerSubmitReport: messenger.messengerSubmitReport,
  messengerAdminGetDashboard: messenger.messengerAdminGetDashboard,
  messengerAdminGetReportDetail: messenger.messengerAdminGetReportDetail,
  messengerAdminGetReportRoomselfImage: messenger.messengerAdminGetReportRoomselfImage,
  messengerAdminUpdateReport: messenger.messengerAdminUpdateReport,
  messengerAdminSetBan: messenger.messengerAdminSetBan,
  messengerAdminGetBanStatus: messenger.messengerAdminGetBanStatus,
  messengerExpireRequests: messenger.messengerExpireRequests,
  messengerPurgeExpiredData: messenger.messengerPurgeExpiredData,
};
