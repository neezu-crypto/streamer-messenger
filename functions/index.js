const { initializeApp } = require('firebase-admin/app');
initializeApp();

const messenger = require('./src/messenger');

module.exports = {
  messengerGetSession: messenger.messengerGetSession,
  messengerEnsureRoom: messenger.messengerEnsureRoom,
  messengerGetRoomState: messenger.messengerGetRoomState,
  messengerUpdateRoom: messenger.messengerUpdateRoom,
  messengerDiscardRoom: messenger.messengerDiscardRoom,
  messengerListApplications: messenger.messengerListApplications,
  messengerListFans: messenger.messengerListFans,
  messengerApplyToRoom: messenger.messengerApplyToRoom,
  messengerReviewApplication: messenger.messengerReviewApplication,
  messengerSetMemberStatus: messenger.messengerSetMemberStatus,
  messengerSendMessage: messenger.messengerSendMessage,
  messengerGetGalleryImages: messenger.messengerGetGalleryImages,
  messengerGetGalleryImage: messenger.messengerGetGalleryImage,
  messengerSubmitReport: messenger.messengerSubmitReport,
  messengerAdminGetDashboard: messenger.messengerAdminGetDashboard,
  messengerAdminGetReportDetail: messenger.messengerAdminGetReportDetail,
  messengerAdminUpdateReport: messenger.messengerAdminUpdateReport,
  messengerAdminSetBan: messenger.messengerAdminSetBan,
  messengerAdminGetBanStatus: messenger.messengerAdminGetBanStatus,
  messengerExpireRequests: messenger.messengerExpireRequests,
  messengerPurgeExpiredData: messenger.messengerPurgeExpiredData,
};
